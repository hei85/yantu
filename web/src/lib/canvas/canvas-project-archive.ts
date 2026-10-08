import { readZip } from "@/lib/zip";
import { nanoid } from "nanoid";
import { collectCanvasStorageKeys } from "@/lib/canvas/canvas-export";
import { remapArchiveProjectMedia } from "@/lib/canvas/canvas-archive-media-remap";
import { getActiveUserScope } from "@/lib/user-scope";
import { setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import type { CanvasExportFile } from "@/types/canvas-export";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { saveCanvasDrawing, type CanvasDrawingRenderDraft } from "@/lib/canvas/canvas-drawing-storage";
import type { CanvasDrawingEngine } from "@/lib/canvas/canvas-drawing-engine";
import { resourceFileUrl, resourceStorageKey, ResourceUploadError, uploadResourceFile } from "@/services/api/resources";
import { primeResourceBlobCache } from "@/services/resource-blob-cache";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { listProjectAssetFolders, listProjects } from "@/services/api/projects";
export class CanvasArchiveImportError extends Error {
    constructor(message: string, readonly createdProjectIds: string[], readonly completedProjectIds: string[], readonly recovery: { resourceIds: string[]; localStorageKeys: string[]; assetIds: string[] }, options?: ErrorOptions) {
        super(message, options);
        this.name = "CanvasArchiveImportError";
    }
}

export async function importCanvasProjectArchive(file: Blob, options: { onProgress?: (completed: number, total: number) => void; preferLocal?: boolean } = {}) {
    const createdProjectIds: string[] = [];
    const importedProjectIds: string[] = [];
    const detachedAssociations: Array<{ canvasId: string; sourceProjectId: string }> = [];
    const detachedFolders: Array<{ canvasId: string; nodeId: string; sourceProjectId?: string; sourceAssetFolderId?: string }> = [];
    const createdResourceIds: string[] = [];
    const createdLocalStorageKeys: string[] = [];
    const createdAssetIds: string[] = [];
        try {
            const zip = await readZip(file, {
                maxCompressedBytes: 100 * 1024 * 1024,
                maxEntries: 5_000,
                maxEntryBytes: 256 * 1024 * 1024,
                maxTotalBytes: 512 * 1024 * 1024,
            });
            const projectFile = zip.get("projects.json");
            if (!projectFile) throw new Error("缺少 projects.json 元数据文件");
            const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
            if (data.app !== "infinite-canvas" || ![3, 4].includes(data.version)) throw new Error("不支持的画布压缩包格式");
            if (!Array.isArray(data.projects)) throw new Error("projects.json 中缺少画布列表");
            const sourceProjectIds = [...new Set(data.projects.map((item) => item.project?.projectId).filter((id): id is string => Boolean(id)))];
            let availableProjectIds = new Set<string>();
            if (sourceProjectIds.length && !options.preferLocal) {
                try {
                    availableProjectIds = new Set((await listProjects()).projects.map(({ project }) => project.id));
                } catch (error) {
                    console.warn("导入画布时无法核验原短剧项目关联，将作为独立画布导入", error);
                }
            }
            for (const item of data.projects) {
                if (!item.project || !Array.isArray(item.project.nodes)) throw new Error("画布元数据无效");
                if (!Array.isArray(item.files)) throw new Error(`画布「${item.project?.title || "未命名画布"}」的媒体清单无效`);
                const missing = item.files.find((entry) => !zip.get(entry.path));
                if (missing) throw new Error(`压缩包缺少媒体文件：${missing.path}`);
                const wrongSize = item.files.find((entry) => typeof entry.bytes === "number" && zip.get(entry.path)?.size !== entry.bytes);
                if (wrongSize) throw new Error(`压缩包媒体大小不匹配：${wrongSize.path}`);
                const keys = new Set(item.files.map((entry) => entry.storageKey));
                if (keys.size !== item.files.length) throw new Error(`画布「${item.project.title}」的媒体清单含重复键`);
                const missingKey = collectCanvasStorageKeys(item.project).find((key) => !keys.has(key));
                if (missingKey) throw new Error(`画布「${item.project.title}」缺少媒体引用：${missingKey}`);
                for (const document of item.drawingDocuments || []) {
                    if (document.previewPath && !zip.get(document.previewPath)) throw new Error(`压缩包缺少绘图预览：${document.previewPath}`);
                    if (document.generationRender?.path && !zip.get(document.generationRender.path)) throw new Error(`压缩包缺少绘图渲染：${document.generationRender.path}`);
                }
                const drawings = new Set((item.drawingDocuments || []).map((document) => document.drawingId));
                const missingDrawing = item.project.nodes.find((node) => node.type === CanvasNodeType.Drawing && node.metadata?.drawingId && !drawings.has(node.metadata.drawingId));
                if (missingDrawing) throw new Error(`画布「${item.project.title}」缺少绘图文档：${missingDrawing.metadata?.drawingId}`);
            }
            for (const item of data.projects) {
                const domainProjectId = !options.preferLocal && item.project.projectId && availableProjectIds.has(item.project.projectId) ? item.project.projectId : undefined;
                const importedProjectId = useCanvasStore.getState().importProject({
                    ...item.project,
                    projectId: domainProjectId,
                    title: item.project.title || "导入画布",
                    nodes: [],
                    connections: [],
                    timeline: undefined,
                });
                createdProjectIds.push(importedProjectId);
                if (item.project.projectId && !domainProjectId) detachedAssociations.push({ canvasId: importedProjectId, sourceProjectId: item.project.projectId });

                try {
                    const storageKeyMap = new Map<string, { storageKey: string; url: string }>();
                    const concurrency = 4;
                    let fileIndex = 0;
                    const workers = new Array(Math.min(item.files.length, concurrency)).fill(null).map(async () => {
                        while (fileIndex < item.files.length) {
                            const current = fileIndex++;
                            const fileItem = item.files[current];
                            const blob = zip.get(fileItem.path)!;
                            const mime = fileItem.mimeType || blob.type || "image/png";
                            const typedBlob = blob.type ? blob : blob.slice(0, blob.size, mime);
                            const kind: "image" | "video" | "audio" | "file" = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file";

                            const saveLocally = async () => {
                                const isImage = kind === "image";
                                const localStorageKey = `${isImage ? "image" : "media"}:${getActiveUserScope()}:${nanoid()}`;
                                const localUrl = await (isImage ? setImageBlob(localStorageKey, typedBlob) : setMediaBlob(localStorageKey, typedBlob));
                                if (!localUrl) throw new Error(`媒体本地保存失败：${fileItem.path}`);
                                createdLocalStorageKeys.push(localStorageKey);
                                storageKeyMap.set(fileItem.storageKey, { storageKey: localStorageKey, url: localUrl });
                            };
                            if (options.preferLocal) {
                                await saveLocally();
                                continue;
                            }
                            try {
                                const resource = await uploadResourceFile(typedBlob, kind, { fileName: fileItem.path.split("/").pop() });
                                createdResourceIds.push(resource.id);
                                const newStorageKey = resourceStorageKey(resource.id);
                                const newUrl = resourceFileUrl(resource.id);
                                await primeResourceBlobCache(newStorageKey, typedBlob).catch(() => "");
                                storageKeyMap.set(fileItem.storageKey, { storageKey: newStorageKey, url: newUrl });
                            } catch (uploadErr) {
                                if (uploadErr instanceof ResourceUploadError && uploadErr.permanent) throw uploadErr;
                                console.warn("上传资源到后端失败，降级保存本地", uploadErr);
                                await saveLocally();
                            }
                        }
                    });
                    const uploadResults = await Promise.allSettled(workers);
                    const failedUpload = uploadResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
                    if (failedUpload) throw failedUpload.reason;

                    const drawingEngineById = new Map<string, CanvasDrawingEngine>((item.drawingDocuments || []).map((document) => [document.drawingId, document.engine || "tldraw"]));
                    const remappedProject = remapArchiveProjectMedia(item.project, storageKeyMap, drawingEngineById);
                    let remappedNodes = remappedProject.nodes || [];
                    let validAssetFolderIds = new Set<string>();
                    if (domainProjectId && remappedNodes.some((node) => node.metadata?.folder?.assetFolderId)) {
                        try {
                            validAssetFolderIds = new Set((await listProjectAssetFolders(domainProjectId)).folders.map((folder) => folder.id));
                        } catch (error) {
                            console.warn("无法核验项目素材文件夹关联，导入时将解除这些关联", error);
                        }
                    }
                    remappedNodes = remappedNodes.map((node) => {
                        const folder = node.metadata?.folder;
                        if (folder?.projectId || folder?.assetFolderId) {
                            const validLink = Boolean(domainProjectId && folder.projectId === domainProjectId && folder.assetFolderId && validAssetFolderIds.has(folder.assetFolderId));
                            if (!validLink) {
                                detachedFolders.push({ canvasId: importedProjectId, nodeId: node.id, sourceProjectId: folder.projectId, sourceAssetFolderId: folder.assetFolderId });
                                return { ...node, metadata: { ...node.metadata, folder: { ...folder, projectId: undefined, assetFolderId: undefined } } };
                            }
                        }
                        if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) return node;
                        const metadata = { ...node.metadata };
                        delete metadata.assetId;
                        return { ...node, metadata };
                    });
                    let remappedTimeline = remappedProject.timeline
                        ? {
                              ...remappedProject.timeline,
                              clips: remappedProject.timeline.clips.map((clip) => {
                                  const directMedia = clip.directMedia;
                                  if (!directMedia?.storageKey) return clip;
                                  return { ...clip, directMedia: { ...directMedia, assetId: undefined } };
                              }),
                          }
                        : undefined;
                    useCanvasStore.getState().updateProject(importedProjectId, { nodes: remappedNodes, connections: remappedProject.connections || [], chatSessions: remappedProject.chatSessions || [], directorScenes: remappedProject.directorScenes || [], timeline: remappedTimeline });

                    const assetIdByStorageKey = new Map<string, string>();
                    for (let index = 0; index < remappedNodes.length; index += 1) {
                        const node = remappedNodes[index];
                        const isMedia = node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio;
                        if (!isMedia || !node.metadata?.content) continue;
                        const storageKey = node.metadata.storageKey || "";
                        let assetId = storageKey ? assetIdByStorageKey.get(storageKey) : undefined;
                        if (!assetId) {
                            const result = await ensureCanvasNodeAsset({ canvasId: importedProjectId, domainProjectId, node, source: "canvas-upload" });
                            if (result.created) createdAssetIds.push(result.assetId);
                            assetId = result.assetId;
                            if (storageKey) assetIdByStorageKey.set(storageKey, assetId);
                        }
                        remappedNodes[index] = { ...node, metadata: { ...node.metadata, assetId } };
                    }
                    if (remappedTimeline) {
                        const clips: typeof remappedTimeline.clips = [];
                        for (const clip of remappedTimeline.clips) {
                            const media = clip.directMedia;
                            const content = media?.url || media?.dataUrl || media?.content || "";
                            if (!media || !media.storageKey || !content || media.kind === "text") {
                                clips.push(clip);
                                continue;
                            }
                            let assetId = assetIdByStorageKey.get(media.storageKey);
                            if (!assetId) {
                                const type = media.kind === "audio" ? CanvasNodeType.Audio : media.kind === "video" ? CanvasNodeType.Video : CanvasNodeType.Image;
                                const node: CanvasNodeData = {
                                    id: media.id,
                                    type,
                                    title: media.title,
                                    position: { x: 0, y: 0 },
                                    width: media.width || 320,
                                    height: media.height || (type === CanvasNodeType.Audio ? 120 : 240),
                                    metadata: { content, storageKey: media.storageKey, naturalWidth: media.width, naturalHeight: media.height, durationMs: media.durationMs, bytes: media.bytes, mimeType: media.mimeType },
                                };
                                const result = await ensureCanvasNodeAsset({ canvasId: importedProjectId, domainProjectId, node, source: "canvas-upload" });
                                if (result.created) createdAssetIds.push(result.assetId);
                                assetId = result.assetId;
                                assetIdByStorageKey.set(media.storageKey, assetId);
                            }
                            clips.push({ ...clip, directMedia: { ...media, assetId } });
                        }
                        remappedTimeline = { ...remappedTimeline, clips };
                    }
                    useCanvasStore.getState().updateProject(importedProjectId, { nodes: remappedNodes, timeline: remappedTimeline });

                    await Promise.all(
                        (item.drawingDocuments || []).map((document) => {
                            const previewFile = document.previewPath ? zip.get(document.previewPath) : undefined;
                            const preview = previewFile && !previewFile.type ? previewFile.slice(0, previewFile.size, "image/png") : previewFile;
                            const renderFile = document.generationRender?.path ? zip.get(document.generationRender.path) : undefined;
                            const renderBlob = renderFile && !renderFile.type ? renderFile.slice(0, renderFile.size, document.generationRender?.mimeType || "image/png") : renderFile;
                            const render =
                                renderBlob && document.generationRender
                                    ? ({
                                          blob: renderBlob,
                                          pageId: document.generationRender.pageId,
                                          width: document.generationRender.width,
                                          height: document.generationRender.height,
                                          mimeType: document.generationRender.mimeType,
                                          background: document.generationRender.background,
                                      } satisfies CanvasDrawingRenderDraft)
                                    : undefined;
                            const engine = document.engine || "tldraw";
                            return saveCanvasDrawing(
                                importedProjectId,
                                document.drawingId,
                                engine,
                                document.snapshot,
                                {
                                    version: 2,
                                    engine,
                                    snapshot: document.snapshot,
                                    revision: Math.max(0, document.revision - 1),
                                    updatedAt: document.updatedAt,
                                    shapeCount: document.shapeCount,
                                    pageCount: document.pageCount,
                                },
                                preview,
                                render,
                            );
                        }),
                    );

                    await flushCanvasStorePersistence();
                    importedProjectIds.push(importedProjectId);
                    options.onProgress?.(importedProjectIds.length, data.projects.length);
                } catch (error) {
                    throw error;
                }
            }

            await flushCanvasStorePersistence();
        } catch (error) {
            // Resource/Asset writes may already be durable. Preserve created projects so callers
            // can inspect and recover partial imports; silently deleting local projects would
            // leave invisible backend objects and falsely imply an atomic rollback.
            for (const id of createdProjectIds.filter((projectId) => !importedProjectIds.includes(projectId))) {
                const project = useCanvasStore.getState().openProject(id);
                if (project && !project.title.startsWith("[导入未完成]")) useCanvasStore.getState().renameProject(id, `[导入未完成] ${project.title}`);
            }
            let persistenceError: unknown;
            try { await flushCanvasStorePersistence(); } catch (flushError) { persistenceError = flushError; }
            const reason = error instanceof Error ? error.message : String(error);
            const recoveryMessage = createdProjectIds.length ? `；已创建 ${createdProjectIds.length} 个画布，其中 ${importedProjectIds.length} 个完整。未完成画布已标记并保留供检查。` : "";
            const saveMessage = persistenceError ? "；本地保存也失败，请立即检查画布列表" : "";
            const cause = persistenceError ? new AggregateError([error, persistenceError], "画布导入与本地保存均失败") : error;
            throw new CanvasArchiveImportError(`导入未完成：${reason}${recoveryMessage}${saveMessage}`, [...createdProjectIds], [...importedProjectIds], { resourceIds: [...new Set(createdResourceIds)], localStorageKeys: [...new Set(createdLocalStorageKeys)], assetIds: [...new Set(createdAssetIds)] }, { cause });
        }
        return { projectIds: importedProjectIds, projectCount: importedProjectIds.length, detachedAssociations, detachedFolders };
}
