import { useEffect, useRef, useState } from "react";
import { Bot, X } from "lucide-react";
import { nanoid } from "nanoid";

import {
    canvasOperationPostconditionMessage,
    hashCanvasSnapshot,
    verifyCanvasOperations,
    type CanvasApplyOpsSnapshot,
    type CanvasOperation,
    type CanvasSnapshot,
} from "@/lib/canvas/canvas-operation-contract";
import { canvasToolPreconditionConflict, hashCanvasSnapshotForStoryboardConfirmation } from "@/lib/canvas/canvas-agent-precondition";
import { layoutCanvasFlow, layoutCanvasNodes, type CanvasLayoutMode } from "@/lib/canvas/canvas-layout";
import { organizeCanvasNodes } from "@/lib/canvas/canvas-organize";
import { createClientId } from "@/lib/client-id";
import { fitNodeSize, VIDEO_NODE_MAX_SIZE } from "@/lib/canvas/canvas-node-size";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { videoMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { canBindProductionTaskSubmission } from "@/lib/canvas/canvas-generation-result-ownership";
import { submittedVideoSettingsMetadata } from "@/lib/canvas/canvas-video-task-settings";
import { mergeVideos } from "@/lib/canvas/canvas-video-merge";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { storeGeneratedVideo } from "@/services/api/video";
import { isFilmAgentToolName, runFilmAgentTool } from "@/services/api/film-agent-tools";
import { isAgentRuntimeToolName, runAgentRuntimeTool } from "@/services/api/agent-runtime-tools";
import { productionRuns, type ProductionRun } from "@/services/api/production-runs";
import { probeResource, refreshResource, resourceIdFromStorageKey } from "@/services/api/resources";
import type { CanvasAgentTimelineSnapshot, CanvasAgentTimelineOperation, CanvasAgentTimelineOperationResult } from "@/pages/canvas/canvas-agent-timeline-operations";
import type { RecordCanvasAgentOperation } from "@/pages/canvas/use-canvas-operation-history";
import { renderCanvasTimeline } from "@/pages/canvas/canvas-agent-timeline-render";
import type { CanvasAgentMediaOperations } from "@/pages/canvas/canvas-agent-media-operations";
import type { CanvasBatchAgentOperations } from "@/pages/canvas/canvas-agent-batch-operations";
import type { useCanvasBatchTable } from "@/pages/canvas/use-canvas-batch-table";
import type { CanvasAgentFrameOperations } from "@/pages/canvas/canvas-agent-frame-operations";
import { assertNativeNodeMetadataAllowed, type CanvasAgentNativeNodeOperations } from "@/pages/canvas/canvas-agent-native-node-operations";
import { hashDirectorScene, type CanvasAgentDirectorOperations, type CanvasAgentDirectorScenePatch, type CanvasAgentDirectorShotPatch, type CanvasAgentDirectorAddObjectInput, type CanvasAgentDirectorObjectPatch, type CanvasAgentDirectorTransform, type CanvasAgentDirectorCameraPatch, type CanvasAgentDirectorLightPatch, type CanvasAgentDirectorAddLightInput } from "@/pages/canvas/canvas-agent-director-operations";
import type { DirectorHumanoidBone } from "@/types/director";
import { applyTldrawDrawingOperation, type TldrawDrawingOperation } from "@/pages/canvas/canvas-agent-tldraw-operations";
import { drawingEngineForNode, isDrawingEngineAvailable } from "@/lib/canvas/canvas-drawing-engine";
import { useUserStore } from "@/stores/use-user-store";
import type { DirectorTemplateId } from "@/lib/canvas/director/director-templates";
import type { CanvasAgentStoryboardGenerationResult, CanvasAgentStoryboardNodeOperations } from "@/pages/canvas/canvas-agent-storyboard-node-operations";
import type { useCanvasStoryboard } from "@/pages/canvas/use-canvas-storyboard";
import type { CanvasAgentAvailableAssetQuery } from "@/pages/canvas/canvas-agent-available-assets";
import type { CanvasAgentReferenceOperation, CanvasAgentReferenceState } from "@/pages/canvas/canvas-agent-reference-operations";
import { downloadAgentCanvasProjects, importAgentCanvasProjectArchive, listAgentCanvasProjects } from "@/lib/canvas/agent-canvas-project-io";
import { isProjectAgentToolName, runProjectAgentTool } from "@/services/api/project-agent-tools";
import { getLocalRuntimeSessionClient, useLocalRuntimeStore } from "@/stores/use-local-runtime-store";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { buildCanvasNodeMentionReferenceMap } from "@/lib/canvas/canvas-resource-references";
import { loadCanvasDrawing, saveCanvasDrawing, type CanvasDrawingSnapshot } from "@/lib/canvas/canvas-drawing-storage";
import { createDefaultMediaConversionState, mediaConversionSourceFingerprint, type MediaConversionOperation } from "@/lib/media-conversion/contracts";
import { executeMediaConversion, localConversionStorageKey } from "@/lib/media-conversion/execute-conversion";
import { resolveImageUrl, setImageBlob } from "@/services/image-storage";
import { DEFAULT_COLOR_GRADE, renderCanvasColorGradePng } from "@/lib/canvas/canvas-color-grade";
import { waitForCanvasMediaNodeState } from "@/lib/canvas/canvas-media-node-persistence";
import { waitForCanvasDrawingInitialization } from "@/lib/canvas/canvas-drawing-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { getPanoramaAgentController } from "@/lib/canvas/panorama-agent-controller";
import type { CanvasAgentImageOperations, ImageEditInput, ImageAnalyzeInput, ImageDecomposeInput } from "@/pages/canvas/canvas-agent-image-operations";
import type { PanoramaGenerateConfig } from "@/components/canvas/canvas-panorama-config-modal";

type RuntimeStateResult = {
    accepted?: boolean;
    revision?: number;
    stateHash?: string;
    reason?: string;
};

type ToolCallPayload = {
    requestId: string;
    name: string;
    input?: Record<string, unknown>;
};

type StoryboardMediaAgentHook = ReturnType<typeof useCanvasStoryboard>;
type BatchTableAgentHook = ReturnType<typeof useCanvasBatchTable>;

function redactDrawingPayload(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactDrawingPayload);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        if ((key === "dataURL" || key === "src") && typeof item === "string" && item.startsWith("data:image/")) return [key, `[image data omitted; ${item.length} characters]`];
        return [key, redactDrawingPayload(item)];
    }));
}

function emptyExcalidrawDrawing(): CanvasDrawingSnapshot {
    return { version: 2, engine: "excalidraw", snapshot: { elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} }, revision: 0, updatedAt: "", shapeCount: 0, pageCount: 1 };
}

type Props = {
    snapshot: CanvasSnapshot;
    captureDirectorFrame: (input: { sceneId: string; shotId: string; expectedSceneHash: string }) => Promise<unknown>;
    captureDirectorVideo: (input: { sceneId: string; shotId: string; expectedSceneHash: string; durationSeconds: number }) => Promise<unknown>;
    onApplyOps: (ops?: CanvasOperation[], context?: { source?: "online" | "local"; conversationId?: string; messageId?: string }) => Promise<CanvasApplyOpsSnapshot>;
    recordAgentOperation: RecordCanvasAgentOperation;
    exportColorGradeNode: (node: CanvasNodeData, dataUrl: string, title: string) => Promise<void>;
    persistCanvas: () => Promise<boolean>;
    canUndoAgentOps: boolean;
    undoAgentOps: () => CanvasSnapshot | null;
    canRedoAgentOps: boolean;
    redoAgentOps: () => CanvasSnapshot | null;
    duplicateNode: (nodeId: string, mode: "copy") => void;
    toggleNodeLocked: (nodeId: string) => void;
    toggleFrameCollapsed: (nodeId: string) => void;
    insertAsset: (assetId: string, position: { x: number; y: number }, beforeCommit: () => Promise<void>) => Promise<CanvasNodeData[]>;
    prepareAssetNode: (assetId: string, position: { x: number; y: number }, beforeCommit: () => Promise<void>) => Promise<CanvasNodeData>;
    uploadLocalFile: (file: File, nodeId: string | undefined, position: { x: number; y: number }, beforeCommit: () => Promise<void>) => Promise<string>;
    getTimeline: () => Promise<CanvasAgentTimelineSnapshot>;
    applyTimelineOperation: (expectedHash: string, operation: CanvasAgentTimelineOperation) => Promise<CanvasAgentTimelineOperationResult & { snapshot: CanvasSnapshot }>;
    mediaOperations: CanvasAgentMediaOperations;
    imageOperations: CanvasAgentImageOperations;
    createPanoramaViewer: (node: CanvasNodeData, prompt: string, config: PanoramaGenerateConfig) => CanvasNodeData;
    imageNodeAction: (nodeId: string, action: "preview" | "info" | "generation_settings" | "copy_prompt" | "download") => Promise<Record<string, unknown>>;
    batchTableOperations: CanvasBatchAgentOperations;
    preflightBatchRows: BatchTableAgentHook["agentPreflightBatchRows"];
    generateBatchRows: BatchTableAgentHook["agentGenerateBatchRows"];
    editReference: (operation: CanvasAgentReferenceOperation) => CanvasAgentReferenceState;
    frameOperations: CanvasAgentFrameOperations;
    nativeNodeOperations: CanvasAgentNativeNodeOperations;
    directorOperations: CanvasAgentDirectorOperations;
    storyboardNodeOperations: CanvasAgentStoryboardNodeOperations;
    generateStoryboardRows: (input: { nodeId: string; prompt: string; clientOperationId: string }, beforeCommit: () => Promise<void>) => Promise<CanvasAgentStoryboardGenerationResult>;
    preflightStoryboardMedia: StoryboardMediaAgentHook["agentPreflightScriptMedia"];
    generateStoryboardMedia: StoryboardMediaAgentHook["agentGenerateScriptMedia"];
    findAvailableAssets: (input: CanvasAgentAvailableAssetQuery) => { assets: Array<{ assetId: string; title: string; kind: string; category?: string; status?: string; ready: boolean; source: "local" | "project" | "local+project" }>; total: number; limit: number };
    open: boolean;
    onClose: () => void;
};

const canvasReadOnlyTools = new Set([
    "canvas_preflight_image_edit",
    "canvas_get_state", "canvas_get_context", "canvas_get_capabilities", "canvas_find_nodes", "canvas_get_node",
    "canvas_get_connection", "canvas_get_generation_tasks", "canvas_get_resources", "canvas_validate_ops",
    "canvas_get_selection", "canvas_export_snapshot", "canvas_get_storyboard", "canvas_get_timeline", "canvas_get_drawing", "canvas_list_director_scenes", "canvas_get_director_scene", "canvas_list_projects", "canvas_export_projects", "canvas_batch_table_read", "canvas_preflight_batch_rows", "canvas_find_available_assets", "canvas_preflight_storyboard_media", "canvas_inspect_node_render",
]);

export function CanvasLocalAgentBridge({ snapshot, captureDirectorFrame, captureDirectorVideo, onApplyOps, recordAgentOperation, exportColorGradeNode, persistCanvas, canUndoAgentOps, undoAgentOps, canRedoAgentOps, redoAgentOps, duplicateNode, toggleNodeLocked, toggleFrameCollapsed, insertAsset, prepareAssetNode, uploadLocalFile, getTimeline, applyTimelineOperation, mediaOperations, imageOperations, createPanoramaViewer, imageNodeAction, batchTableOperations, preflightBatchRows, generateBatchRows, editReference, frameOperations, nativeNodeOperations, directorOperations, storyboardNodeOperations, generateStoryboardRows, preflightStoryboardMedia, generateStoryboardMedia, findAvailableAssets, open, onClose }: Props) {
    const clientIdRef = useRef(createClientId());
    const snapshotRef = useRef(snapshot);
    const applyOpsRef = useRef(onApplyOps);
    const recordAgentOperationRef = useRef(recordAgentOperation);
    const persistCanvasRef = useRef(persistCanvas);
    const canUndoAgentOpsRef = useRef(canUndoAgentOps);
    const undoAgentOpsRef = useRef(undoAgentOps);
    const canRedoAgentOpsRef = useRef(canRedoAgentOps);
    const redoAgentOpsRef = useRef(redoAgentOps);
    const duplicateNodeRef = useRef(duplicateNode);
    const toggleNodeLockedRef = useRef(toggleNodeLocked);
    const toggleFrameCollapsedRef = useRef(toggleFrameCollapsed);
    const insertAssetRef = useRef(insertAsset);
    const prepareAssetNodeRef = useRef(prepareAssetNode);
    const uploadLocalFileRef = useRef(uploadLocalFile);
    const getTimelineRef = useRef(getTimeline);
    const applyTimelineOperationRef = useRef(applyTimelineOperation);
    const mediaOperationsRef = useRef(mediaOperations);
    const imageOperationsRef = useRef(imageOperations);
    const createPanoramaViewerRef = useRef(createPanoramaViewer);
    const imageNodeActionRef = useRef(imageNodeAction);
    const batchTableOperationsRef = useRef(batchTableOperations);
    const preflightBatchRowsRef = useRef(preflightBatchRows);
    const generateBatchRowsRef = useRef(generateBatchRows);
    const editReferenceRef = useRef(editReference);
    const frameOperationsRef = useRef(frameOperations);
    const nativeNodeOperationsRef = useRef(nativeNodeOperations);
    const directorOperationsRef = useRef(directorOperations);
    const storyboardNodeOperationsRef = useRef(storyboardNodeOperations);
    const generateStoryboardRowsRef = useRef(generateStoryboardRows);
    const preflightStoryboardMediaRef = useRef(preflightStoryboardMedia);
    const generateStoryboardMediaRef = useRef(generateStoryboardMedia);
    const findAvailableAssetsRef = useRef(findAvailableAssets);
    const connectedRef = useRef(false);
    const runtimeRevisionRef = useRef(0);
    const runtimeStateHashRef = useRef("");
    const browserHashRef = useRef("");
    const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
    const syncSnapshotRef = useRef<(value: CanvasSnapshot) => void>(() => undefined);
    const syncTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const activeTimelineRenderIdsRef = useRef(new Set<string>());
    const activeConversionIdsRef = useRef(new Set<string>());
    const [connection, setConnection] = useState<"idle" | "connecting" | "connected" | "error">("idle");
    const [productionRun, setProductionRun] = useState<ProductionRun | null>(null);
    const [productionBusy, setProductionBusy] = useState(false);

    useEffect(() => {
        applyOpsRef.current = onApplyOps;
    }, [onApplyOps]);

    useEffect(() => {
        recordAgentOperationRef.current = recordAgentOperation;
    }, [recordAgentOperation]);

    useEffect(() => {
        persistCanvasRef.current = persistCanvas;
    }, [persistCanvas]);

    useEffect(() => {
        canUndoAgentOpsRef.current = canUndoAgentOps;
        undoAgentOpsRef.current = undoAgentOps;
        canRedoAgentOpsRef.current = canRedoAgentOps;
        redoAgentOpsRef.current = redoAgentOps;
        duplicateNodeRef.current = duplicateNode;
        toggleNodeLockedRef.current = toggleNodeLocked;
        toggleFrameCollapsedRef.current = toggleFrameCollapsed;
        insertAssetRef.current = insertAsset;
        prepareAssetNodeRef.current = prepareAssetNode;
        uploadLocalFileRef.current = uploadLocalFile;
        getTimelineRef.current = getTimeline;
        applyTimelineOperationRef.current = applyTimelineOperation;
        mediaOperationsRef.current = mediaOperations;
        imageOperationsRef.current = imageOperations;
        createPanoramaViewerRef.current = createPanoramaViewer;
        imageNodeActionRef.current = imageNodeAction;
        batchTableOperationsRef.current = batchTableOperations;
        preflightBatchRowsRef.current = preflightBatchRows;
        generateBatchRowsRef.current = generateBatchRows;
        editReferenceRef.current = editReference;
        frameOperationsRef.current = frameOperations;
        nativeNodeOperationsRef.current = nativeNodeOperations;
        directorOperationsRef.current = directorOperations;
        storyboardNodeOperationsRef.current = storyboardNodeOperations;
        generateStoryboardRowsRef.current = generateStoryboardRows;
        preflightStoryboardMediaRef.current = preflightStoryboardMedia;
        generateStoryboardMediaRef.current = generateStoryboardMedia;
        findAvailableAssetsRef.current = findAvailableAssets;
    }, [canUndoAgentOps, undoAgentOps, canRedoAgentOps, redoAgentOps, duplicateNode, toggleNodeLocked, toggleFrameCollapsed, insertAsset, prepareAssetNode, uploadLocalFile, getTimeline, applyTimelineOperation, mediaOperations, imageOperations, createPanoramaViewer, imageNodeAction, batchTableOperations, preflightBatchRows, generateBatchRows, editReference, frameOperations, nativeNodeOperations, directorOperations, storyboardNodeOperations, generateStoryboardRows, preflightStoryboardMedia, generateStoryboardMedia, findAvailableAssets]);

    useEffect(() => {
        snapshotRef.current = snapshot;
        if (!connectedRef.current) return;
        if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
        syncTimerRef.current = setTimeout(() => syncSnapshotRef.current(snapshot), 250);
        return () => {
            if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
        };
    }, [snapshot]);

    useEffect(() => {
        if (!open || !snapshot.projectId) return;
        const controller = new AbortController();
        const load = async () => {
            try {
                const result = await productionRuns.list(controller.signal);
                const matching = result.runs
                    .filter((run) => !run.canvasId || run.canvasId === snapshot.projectId)
                    .filter((run) => !["completed", "cancelled", "failed"].includes(String(run.status)))
                    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
                setProductionRun(matching[0] || null);
            } catch {
                setProductionRun(null);
            }
        };
        void load();
        return () => controller.abort();
    }, [open, snapshot.projectId]);

    const runProductionAction = async (action: "authorize" | "pause" | "resume" | "cancel") => {
        if (!productionRun || productionBusy) return;
        setProductionBusy(true);
        try {
            const next = action === "authorize"
                ? await productionRuns.authorize(productionRun.id, {
                    expectedRevision: productionRun.revision,
                    policy: {
                        allowedCapabilities: ["text", "image", "video", "audio"],
                        allowAutomaticWithinBudget: true,
                        budgetLimit: productionRun.budgetLimit,
                        source: "canvas-local-agent-panel",
                    },
                })
                : await productionRuns.action(productionRun.id, { expectedRevision: productionRun.revision, action });
            setProductionRun(next);
        } catch (error) {
            console.warn("[yingce-local-agent] 制作操作失败", error);
        } finally {
            setProductionBusy(false);
        }
    };
    useEffect(() => {
        const controller = new AbortController();
        let retryDelay = 500;

        const syncRuntimeState = async (next: CanvasSnapshot, retry = false): Promise<void> => {
            const nextHash = hashCanvasSnapshot(next);
            const changed = Boolean(browserHashRef.current) && browserHashRef.current !== nextHash;
            const revision = changed ? runtimeRevisionRef.current + 1 : runtimeRevisionRef.current;
            const response = await getLocalRuntimeSessionClient().request(`/canvas/state?clientId=${encodeURIComponent(clientIdRef.current)}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ...next, clientId: clientIdRef.current, revision }),
            });
            const body = (await response.json().catch(() => ({}))) as RuntimeStateResult;
        if (response.status === 409 && !retry && typeof body.revision === "number") {
            // 新建/切换画布时，本地运行时里可能还留着上一个画布的状态；
            // 同一个 revision 会被判为冲突，所以直接前进一格再重试一次。
            runtimeRevisionRef.current = body.revision + 1;
            browserHashRef.current = "";
            return syncRuntimeState(next, true);
        }
            if (!response.ok || body.accepted !== true || typeof body.revision !== "number" || typeof body.stateHash !== "string") {
                throw new Error(body.reason || "画布状态同步失败");
            }
            runtimeRevisionRef.current = body.revision;
            runtimeStateHashRef.current = body.stateHash;
            browserHashRef.current = nextHash;
        };

        const enqueueStateSync = (next: CanvasSnapshot) => {
            syncQueueRef.current = syncQueueRef.current
                .catch(() => undefined)
                .then(() => syncRuntimeState(next))
                .then(() => undefined);
            return syncQueueRef.current;
        };
    syncSnapshotRef.current = (next) => {
        // 同步失败只影响本地 Agent 看到的画布快照，不应把未处理的 Promise 异常抛到页面上；
        // 下一次快照变化会重新排队重试。
        void enqueueStateSync(next).catch((error) => console.debug("[yingce-local-agent] 画布状态同步失败，将在下次变更时重试", error));
    };

        const postResult = async (payload: { requestId: string; result?: unknown; error?: string }) => {
            const response = await getLocalRuntimeSessionClient().request(`/canvas/result?clientId=${encodeURIComponent(clientIdRef.current)}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (!response.ok) throw new Error("本地 Agent 工具结果写回失败");
        };

        const runToolCall = async (payload: ToolCallPayload) => {
            try {
                const input = payload.input ?? {};
                if (payload.name === "canvas_inspect_node_render") {
                    const nodeId = typeof input.nodeId === "string" ? input.nodeId : "";
                    const node = snapshotRef.current.nodes.find((item) => item.id === nodeId);
                    if (!node) throw new Error(`找不到画布节点：${nodeId}`);
                    const panoramaController = node.type === CanvasNodeType.Panorama ? getPanoramaAgentController(nodeId) : null;
                    const panoramaMode = panoramaController?.availability ?? "not_registered";
                    const element = [...document.querySelectorAll<HTMLElement>("[data-node-id]")].find((item) => item.dataset.nodeId === nodeId);
                    if (!element) {
                        await postResult({ requestId: payload.requestId, result: { nodeId, nodeType: node.type, mounted: false, ...(node.type === CanvasNodeType.Panorama ? { panoramaMode } : {}), hint: panoramaMode === "performance_preview" ? "性能模式下全景节点仅显示预览；请退出性能模式后重试" : "请用 canvas_set_viewport 将节点移入视口后重试" } });
                        return;
                    }
                    const rect = element.getBoundingClientRect();
                    const style = getComputedStyle(element);
                    const visible = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
                    const viewport = { width: window.innerWidth, height: window.innerHeight };
                    const intersectsViewport = rect.right > 0 && rect.bottom > 0 && rect.left < viewport.width && rect.top < viewport.height;
                    const shell = element.querySelector<HTMLElement>(".canvas-node-shell") || element;
                    const counts = (selector: string) => shell.querySelectorAll(selector).length;
                    const frame = shell.querySelector<HTMLIFrameElement>("iframe");
                    const readSandboxDom = async () => {
                        if (!frame?.contentWindow || !frame.dataset.previewReady) return null;
                        const nonce = crypto.randomUUID();
                        return await new Promise<Record<string, unknown> | null>((resolve) => {
                            const finish = (value: Record<string, unknown> | null) => { window.clearTimeout(timer); window.removeEventListener("message", onMessage); resolve(value); };
                            const onMessage = (event: MessageEvent) => {
                                const data = event.data as { type?: unknown; nonce?: unknown; payload?: unknown } | null;
                                if (event.source !== frame.contentWindow || data?.type !== "yingtu-dom-diagnostic-response" || data.nonce !== nonce || !data.payload || typeof data.payload !== "object") return;
                                finish(data.payload as Record<string, unknown>);
                            };
                            const timer = window.setTimeout(() => finish(null), 600);
                            window.addEventListener("message", onMessage);
                            frame.contentWindow?.postMessage({ type: "yingtu-dom-diagnostic-request", nonce }, "*");
                        });
                    };
                    const detail = node.type === CanvasNodeType.Chart ? {
                        svgCount: counts("svg"), pathCount: counts("svg path"), rectCount: counts("svg rect"), textCount: counts("svg text"),
                        svgViewBoxes: [...shell.querySelectorAll<SVGSVGElement>("svg")].map((svg) => svg.getAttribute("viewBox")),
                    } : node.type === CanvasNodeType.Markdown ? {
                        headingCount: counts("h1,h2,h3,h4,h5,h6"), paragraphCount: counts("p"), listCount: counts("ul,ol"), codeBlockCount: counts("pre"),
                        renderedTextCharacters: (shell.innerText || "").trim().length, scrollHeight: shell.scrollHeight, clientHeight: shell.clientHeight,
                    } : node.type === CanvasNodeType.Html || node.type === CanvasNodeType.Svg ? {
                        iframeLoaded: frame?.dataset.previewReady === "true" ? true : frame?.dataset.previewReady === "false" ? false : null,
                        iframeBounds: frame ? (() => { const r = frame.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })() : null,
                        sandbox: frame?.getAttribute("sandbox") ?? null,
                        diagnostic: node.type === CanvasNodeType.Html ? await readSandboxDom() : null,
                        note: node.type === CanvasNodeType.Html ? "通过nonce postMessage读取HTML沙箱的DOM尺寸/结构，仅作DOM诊断，不是像素验收。" : "SVG预览保持脚本禁用，仅读取iframe加载标记和外框；不读取内部DOM。",
                    } : node.type === CanvasNodeType.Panorama ? {
                        panoramaMode, childElementCount: shell.childElementCount,
                        renderedTextCharacters: (shell.innerText || "").trim().length,
                        scrollHeight: shell.scrollHeight, clientHeight: shell.clientHeight,
                    } : { childElementCount: shell.childElementCount, renderedTextCharacters: (shell.innerText || "").trim().length, scrollHeight: shell.scrollHeight, clientHeight: shell.clientHeight };
                    await postResult({ requestId: payload.requestId, result: { nodeId, nodeType: node.type, mounted: true, ...(node.type === CanvasNodeType.Panorama ? { panoramaMode } : {}), visible, intersectsViewport, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport, detail } });
                    return;
                }
                if (payload.name === "canvas_set_panorama_view" || payload.name === "canvas_capture_panorama_view") {
                    const expectedCanvasId = String(input.expectedCanvasId || "");
                    if (expectedCanvasId !== snapshotRef.current.projectId) throw new Error("请求目标画布与当前画布不一致");
                    const conflict = await canvasToolPreconditionConflict({ flushPendingStateSync: () => syncQueueRef.current, readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }), expectedRevision: input.expectedRevision, expectedStateHash: input.expectedStateHash });
                    if (conflict) throw new Error("画布状态已变化，请重新读取 canvas_get_context 后重试");
                    const node = snapshotRef.current.nodes.find((item) => item.id === input.nodeId);
                    if (!node || node.type !== CanvasNodeType.Panorama) throw new Error("nodeId 必须指向全景节点");
                    const controller = getPanoramaAgentController(node.id);
                    if (!controller) throw new Error("全景节点当前未挂载；请用 canvas_set_viewport 将节点移入视口后重试");
                    if (payload.name === "canvas_set_panorama_view") {
                        const view = await controller.setView({ lon: Number(input.lon), lat: Number(input.lat), ...(typeof input.fov === "number" ? { fov: input.fov } : {}) });
                        await postResult({ requestId: payload.requestId, result: { ok: true, nodeId: node.id, view } });
                        return;
                    }
                    const before = snapshotRef.current;
                    const beforeIds = new Set(before.nodes.map((item) => item.id));
                    const captureMode = input.mode === "quad" ? "quad" : "view";
                    const captured = captureMode === "quad" ? await controller.captureQuadPng() : await controller.capturePng();
                    if (!captured.dataUrl.startsWith("data:image/png;base64,") || captured.width <= 0 || captured.height <= 0) throw new Error("全景 WebGL renderer 未返回有效 PNG");
                    const outputTitle = `${node.title || "全景"} · ${captureMode === "quad" ? "四向视图" : "视角截图"}`;
                    await exportColorGradeNode(node, captured.dataUrl, outputTitle);
                    await flushCanvasStorePersistence();
                    const persisted = useCanvasStore.getState().projects.find((project) => project.id === before.projectId);
                    const output = persisted?.nodes.find((item) => !beforeIds.has(item.id) && item.type === CanvasNodeType.Image && item.metadata?.storageKey && item.title === outputTitle);
                    const connected = output && persisted?.connections.some((connection) => connection.fromNodeId === node.id && connection.toNodeId === output.id);
                    if (!output?.metadata?.storageKey || !connected) throw new Error("全景截图已捕获，但派生图片资源节点/连线未通过持久化回读");
                    const updated: CanvasSnapshot = { ...before, nodes: persisted!.nodes, connections: persisted!.connections };
                    snapshotRef.current = updated;
                    recordAgentOperationRef.current(before, updated, "捕获全景视角", [node.id, output.id]);
                    await enqueueStateSync(updated);
                    await postResult({ requestId: payload.requestId, result: { ok: true, mode: captureMode, nodeId: output.id, sourceNodeId: node.id, storageKey: output.metadata.storageKey, resourceId: resourceIdFromStorageKey(String(output.metadata.storageKey)), width: captured.width, height: captured.height, persisted: true, snapshot: updated } });
                    return;
                }
                if (payload.name.startsWith("canvas_") && !canvasReadOnlyTools.has(payload.name)) {
                    const current = snapshotRef.current;
                    if (input.expectedCanvasId !== current.projectId) {
                        throw new Error(`请求目标画布 ${String(input.expectedCanvasId)} 与当前标签页画布 ${current.projectId} 不一致`);
                    }
                    const conflict = await canvasToolPreconditionConflict({
                        flushPendingStateSync: () => syncQueueRef.current,
                        readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }),
                        expectedRevision: input.expectedRevision,
                        expectedStateHash: input.expectedStateHash,
                    });
                    if (conflict) throw new Error("画布状态已变化，请重新读取 canvas_get_context 后再执行写操作");
                }
                if (payload.name === "canvas_apply_ops") {
                    // 运行时在工具结果写回时会推进 revision，而本地 refs 只在下一次状态同步成功后更新；
                    // 连续 MCP 写入必须先用待同步队列对齐 refs，否则会把正常的 revision 推进误判成冲突。
                    const preconditionConflict = await canvasToolPreconditionConflict({
                        flushPendingStateSync: () => syncQueueRef.current,
                        readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }),
                        expectedRevision: input.expectedRevision,
                        expectedStateHash: input.expectedStateHash,
                    });
                    if (preconditionConflict === "revision") {
                        throw new Error(`画布 revision 已从 ${input.expectedRevision} 变为 ${runtimeRevisionRef.current}，请重新读取 canvas_get_context 后再执行写操作`);
                    }
                    if (preconditionConflict === "state") {
                        throw new Error("画布状态已变化，请重新读取 canvas_get_context 后再执行写操作");
                    }
                    const before = snapshotRef.current;
                    const ops = Array.isArray(input.ops) ? (input.ops as CanvasOperation[]) : [];
                    const applied = await applyOpsRef.current(ops, { source: "local", conversationId: "codex-mcp", messageId: payload.requestId });
                    const { generationTasks = [], ...next } = applied;
                    const verification = verifyCanvasOperations(before, next, ops);
                    const result = {
                        ok: verification.ok,
                        message: canvasOperationPostconditionMessage(verification),
                        data: { verification, snapshot: next, generationTasks },
                        snapshot: next,
                    };
                    snapshotRef.current = next;
                    await postResult({ requestId: payload.requestId, result });
                    await enqueueStateSync(next);
                    return;
                }
                if (payload.name === "canvas_layout_nodes") {
                    if (input.expectedCanvasId !== snapshotRef.current.projectId) throw new Error("整理画布的目标已切换，请重新读取当前画布");
                    const preconditionConflict = await canvasToolPreconditionConflict({
                        flushPendingStateSync: () => syncQueueRef.current,
                        readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }),
                        expectedRevision: input.expectedRevision,
                        expectedStateHash: input.expectedStateHash,
                    });
                    if (preconditionConflict) throw new Error("画布状态已变化，请重新读取 canvas_get_context 后再整理节点");
                    const before = snapshotRef.current;
                    const requestedIds = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === "string") : before.selectedNodeIds;
                    const hasSelection = requestedIds.length > 0;
                    const requested = hasSelection ? new Set(requestedIds) : null;
                    const mode = input.mode === "row" || input.mode === "column" || input.mode === "grid" || input.mode === "flow" ? input.mode : "auto";
                    let ops: CanvasOperation[];
                    let organization: ReturnType<typeof organizeCanvasNodes> | undefined;
                    if (mode === "auto" || mode === "grid") {
                        organization = organizeCanvasNodes(before.nodes, before.connections, { nodeIds: hasSelection ? requestedIds : undefined, groupByMedia: mode === "auto" });
                        // 父 Frame 的原生移动会带动子节点，随后写入子节点最终世界坐标。
                        const nodesById = new Map(before.nodes.map((node) => [node.id, node]));
                        const depth = (id: string) => {
                            const seen = new Set<string>();
                            let parentId = nodesById.get(id)?.parentId;
                            while (parentId && !seen.has(parentId)) {
                                seen.add(parentId);
                                parentId = nodesById.get(parentId)?.parentId;
                            }
                            return seen.size;
                        };
                        ops = [...organization.patches].sort(([a], [b]) => depth(a) - depth(b)).map(([id, patch]) => ({ type: "update_node", id, patch }));
                    } else {
                        const movable = before.nodes.filter((node) => (!requested || requested.has(node.id))
                            && !node.metadata?.locked
                            && node.type !== CanvasNodeType.Frame
                            && (hasSelection || !node.parentId));
                        if (movable.length < 2) throw new Error("至少需要两个可整理节点");
                        const positions = mode === "flow" ? layoutCanvasFlow(movable, before.connections) : layoutCanvasNodes(movable, mode as CanvasLayoutMode);
                        ops = [...positions].map(([id, position]) => ({ type: "update_node", id, patch: { position } }));
                    }
                    if (!ops.length) {
                        await postResult({ requestId: payload.requestId, result: { ok: true, mode, changed: false, movedNodeIds: [], preservedNodeIds: organization?.preservedNodeIds || [], sections: organization?.sections || [], snapshot: before } });
                        return;
                    }
                    const next = await applyOpsRef.current(ops, { source: "local", conversationId: "codex-mcp", messageId: payload.requestId });
                    const verification = verifyCanvasOperations(before, next, ops);
                    if (!verification.ok) throw new Error(canvasOperationPostconditionMessage(verification));
                    snapshotRef.current = next;
                    const result = { ok: true, mode, changed: true, movedNodeIds: ops.flatMap((op) => op.type === "update_node" ? [op.id] : []), preservedNodeIds: organization?.preservedNodeIds || [], sections: organization?.sections || [], snapshot: next };
                    await postResult({ requestId: payload.requestId, result });
                    await enqueueStateSync(next);
                    return;
                }
                if (payload.name === "canvas_export_color_grade") {
                    if (input.expectedCanvasId !== snapshotRef.current.projectId) throw new Error("调色导出目标画布已切换");
                    const conflict = await canvasToolPreconditionConflict({
                        flushPendingStateSync: () => syncQueueRef.current,
                        readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }),
                        expectedRevision: input.expectedRevision,
                        expectedStateHash: input.expectedStateHash,
                    });
                    if (conflict) throw new Error("画布状态已变化，请重新读取 canvas_get_context 后导出调色结果");
                    const before = snapshotRef.current;
                    const node = before.nodes.find((item) => item.id === input.nodeId);
                    if (!node || node.type !== CanvasNodeType.ColorGrade) throw new Error("nodeId 必须指向调色节点");
                    const sourceId = before.connections.find((connection) => connection.toNodeId === node.id)?.fromNodeId;
                    const source = before.nodes.find((item) => item.id === sourceId && item.type === CanvasNodeType.Image && Boolean(item.metadata?.content));
                    if (!source?.metadata?.content) throw new Error("调色节点必须连接一个可读取的图片节点");
                    const sourceUrl = await resolveImageUrl(source.metadata.storageKey, source.metadata.content, { cacheMiss: true });
                    const rendered = await renderCanvasColorGradePng(sourceUrl, node.metadata?.colorGrade || DEFAULT_COLOR_GRADE);
                    const title = `${node.title || "调色"} · 调色导出`;
                    await exportColorGradeNode(node, rendered.dataUrl, title);
                    await flushCanvasStorePersistence();
                    const persisted = useCanvasStore.getState().projects.find((project) => project.id === before.projectId);
                    const previousConnectionIds = new Set(before.connections.map((connection) => connection.id));
                    const outputConnection = persisted?.connections.find((connection) => connection.fromNodeId === node.id && !previousConnectionIds.has(connection.id));
                    const persistedNode = persisted?.nodes.find((item) => item.id === outputConnection?.toNodeId);
                    if (!persistedNode || persistedNode.type !== CanvasNodeType.Image || !persistedNode.metadata?.storageKey) throw new Error("调色PNG已生成，但派生图片节点或资源连线尚未通过持久化回读");
                    const updated: CanvasSnapshot = { ...before, nodes: persisted!.nodes, connections: persisted!.connections };
                    snapshotRef.current = updated;
                    recordAgentOperationRef.current(before, updated, "导出调色PNG", [node.id, persistedNode.id]);
                    await enqueueStateSync(updated);
                    await postResult({ requestId: payload.requestId, result: { ok: true, sourceNodeId: node.id, nodeId: persistedNode.id, storageKey: persistedNode.metadata.storageKey, resourceId: resourceIdFromStorageKey(String(persistedNode.metadata.storageKey)), width: rendered.width, height: rendered.height, persisted: true, snapshot: updated } });
                    return;
                }
                if (payload.name === "canvas_undo_agent_ops" || payload.name === "canvas_redo_agent_ops") {
                    const preconditionConflict = await canvasToolPreconditionConflict({
                        flushPendingStateSync: () => syncQueueRef.current,
                        readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }),
                        expectedRevision: input.expectedRevision,
                        expectedStateHash: input.expectedStateHash,
                    });
                    if (preconditionConflict) throw new Error("画布状态已变化，请重新读取 canvas_get_context 后再撤销/重做");
                    const isRedo = payload.name === "canvas_redo_agent_ops";
                    if (isRedo ? !canRedoAgentOpsRef.current : !canUndoAgentOpsRef.current) throw new Error(isRedo ? "当前画布没有可重做的 Agent 操作" : "当前画布没有可撤销的 Agent 操作");
                    const before = snapshotRef.current;
                    const restored = isRedo ? redoAgentOpsRef.current() : undoAgentOpsRef.current();
                    if (!restored) throw new Error(isRedo ? "最近的 Agent 撤销已被画布后续修改打断，无法安全重做；请重新读取画布" : "最近的 Agent 操作已被画布后续修改打断，无法安全撤销；请重新读取画布");
                    if (restored.projectId !== before.projectId) throw new Error("撤销/重做结果属于其他画布，已拒绝回报成功");
                    if (hashCanvasSnapshot(restored) === hashCanvasSnapshot(before)) throw new Error("原生撤销/重做未产生可验证的画布状态变化");
                    snapshotRef.current = restored;
                    await postResult({ requestId: payload.requestId, result: { ok: true, action: isRedo ? "redo" : "undo", scope: "latest_canvas_agent_operation", snapshot: restored } });
                    await enqueueStateSync(restored);
                    return;
                }
                if (payload.name === "canvas_insert_asset" || payload.name === "canvas_replace_node_media") {
                    const before = snapshotRef.current;
                    const assetId = typeof input.assetId === "string" ? input.assetId : "";
                    if (!assetId) throw new Error("缺少素材 assetId");
                    const target = payload.name === "canvas_replace_node_media"
                        ? before.nodes.find((node) => node.id === input.nodeId)
                        : undefined;
                    if (payload.name === "canvas_replace_node_media" && !target) throw new Error(`找不到画布节点：${String(input.nodeId)}`);
                    const position = target?.position || { x: -before.viewport.x / before.viewport.k, y: -before.viewport.y / before.viewport.k };
                    const waitForSnapshot = async (predicate: (value: CanvasSnapshot) => boolean, action: string) => {
                        for (let attempt = 0; attempt < 100; attempt += 1) {
                            const current = snapshotRef.current;
                            if (current.projectId !== before.projectId) throw new Error("操作期间画布已切换，拒绝返回其他画布的结果");
                            if (predicate(current)) return current;
                            await new Promise((resolve) => window.setTimeout(resolve, 20));
                        }
                        throw new Error(`${action}已触发，但页面状态未能在时限内回读确认；请重新读取画布核对`);
                    };
                    const assertStillCurrent = async () => {
                        await syncQueueRef.current;
                        if (snapshotRef.current.projectId !== input.expectedCanvasId || snapshotRef.current.projectId !== before.projectId) throw new Error("素材操作期间活动画布已切换");
                        const conflict = await canvasToolPreconditionConflict({ flushPendingStateSync: () => syncQueueRef.current, readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }), expectedRevision: input.expectedRevision, expectedStateHash: input.expectedStateHash });
                        if (conflict) throw new Error("素材解析期间画布状态已变化，拒绝写入；请重新读取后重试");
                        if (target && JSON.stringify(snapshotRef.current.nodes.find((node) => node.id === target.id)) !== JSON.stringify(target)) throw new Error("素材操作期间目标节点已变化，拒绝覆盖");
                    };
                    if (payload.name === "canvas_insert_asset") {
                        await assertStillCurrent();
                        const created = await insertAssetRef.current(assetId, position, assertStillCurrent);
                        await assertStillCurrent();
                        if (!created.length || created.some((node) => node.metadata?.assetId !== assetId)) throw new Error("原生素材插入流程没有返回可验证的素材节点");
                        const createdIds = new Set(created.map((node) => node.id));
                        const updated = await waitForSnapshot((current) => [...createdIds].every((id) => current.nodes.some((node) => node.id === id && node.metadata?.assetId === assetId)), "素材插入");
                        await flushCanvasStorePersistence();
                        const persisted = useCanvasStore.getState().projects.find((project) => project.id === updated.projectId);
                        if (!persisted || ![...createdIds].every((id) => persisted.nodes.some((node) => node.id === id && node.metadata?.assetId === assetId))) throw new Error("素材插入尚未通过持久化回读");
                        snapshotRef.current = updated;
                        await postResult({ requestId: payload.requestId, result: { ok: true, assetId, nodeIds: [...createdIds], persisted: true, snapshot: updated } });
                        await enqueueStateSync(updated);
                        return;
                    }
                    if (!target || (target.type !== CanvasNodeType.Image && target.type !== CanvasNodeType.Video && target.type !== CanvasNodeType.Audio)) throw new Error("媒体替换仅支持图片、视频或音频节点");
                    await assertStillCurrent();
                    const replacement = await prepareAssetNodeRef.current(assetId, position, assertStillCurrent);
                    await assertStillCurrent();
                    if (replacement.metadata?.assetId !== assetId || replacement.type !== target.type) throw new Error("替换素材必须是同类型媒体且能回读其真实 assetId");
                    const clearedKeys = ["assetId", "taskId", "freeResize", "isBatchRoot", "batchRootId", "batchChildIds", "batchFailedCount", "batchUsesReferenceImages", "generationType", "generationResultPlacement", "copiedFromNodeId", "versionOfNodeId", "model", "size", "quality", "transparentBackground", "count", "references", "primaryImageId", "imageBatchExpanded", "richText", "composerContent"];
                    const metadata = Object.fromEntries(clearedKeys.map((key) => [key, undefined]));
                    Object.assign(metadata, replacement.metadata);
                    const ops: CanvasOperation[] = [{ type: "update_node", id: target.id, patch: { title: replacement.title, width: replacement.width, height: replacement.height, metadata } }];
                    const updated = await applyOpsRef.current(ops, { source: "local", conversationId: "codex-mcp", messageId: payload.requestId });
                    const nextTarget = updated.nodes.find((node) => node.id === target.id);
                    if (!nextTarget || nextTarget.metadata?.assetId !== assetId || nextTarget.type !== target.type) throw new Error("媒体替换操作返回后未能验证节点 ID、类型和资源引用");
                    const pageStoreHasReplacement = await waitForCanvasMediaNodeState(
                        () => useCanvasStore.getState().projects.find((project) => project.id === updated.projectId)?.nodes,
                        { nodeId: target.id, nodeType: target.type, assetId },
                    );
                    if (!pageStoreHasReplacement) throw new Error("媒体替换页面状态尚未同步到项目存储，拒绝报告成功");
                    await flushCanvasStorePersistence();
                    const persistedTarget = useCanvasStore.getState().projects.find((project) => project.id === updated.projectId)?.nodes.find((node) => node.id === target.id);
                    if (!persistedTarget || persistedTarget.metadata?.assetId !== assetId || persistedTarget.type !== target.type) throw new Error("媒体替换尚未通过持久化回读");
                    snapshotRef.current = updated;
                    await postResult({ requestId: payload.requestId, result: { ok: true, nodeId: target.id, assetId, resourceStorageKey: nextTarget.metadata?.storageKey, persisted: true, snapshot: updated } });
                    await enqueueStateSync(updated);
                    return;
                }
                if (payload.name === "canvas_find_available_assets") {
                    const result = findAvailableAssetsRef.current({
                        ...(typeof input.query === "string" ? { query: input.query } : {}),
                        ...(typeof input.kind === "string" ? { kind: input.kind } : {}),
                        ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
                    });
                    await postResult({ requestId: payload.requestId, result });
                    return;
                }
                if (payload.name === "canvas_capture_director_frame") {
                    const expectedCanvasId = String(input.expectedCanvasId || "");
                    if (expectedCanvasId !== snapshotRef.current.projectId) throw new Error("请求目标画布与当前画布不一致");
                    const conflict = await canvasToolPreconditionConflict({
                        flushPendingStateSync: () => syncQueueRef.current,
                        readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }),
                        expectedRevision: input.expectedRevision,
                        expectedStateHash: input.expectedStateHash,
                    });
                    if (conflict) throw new Error("画布状态已变化，请重新读取 canvas_get_context 后重试");
                    const sceneId = String(input.sceneId || "");
                    const shotId = String(input.shotId || "");
                    const expectedSceneHash = String(input.expectedSceneHash || "");
                    const captured = await captureDirectorFrame({ sceneId, shotId, expectedSceneHash });
                    if (!(await persistCanvasRef.current())) throw new Error("导演静帧图片已生成，但画布持久化失败；请回读确认后再重试");
                    const nodeId = captured && typeof captured === "object" && "nodeId" in captured && typeof captured.nodeId === "string" ? captured.nodeId : "";
                    const current = useCanvasStore.getState().projects.find((project) => project.id === expectedCanvasId);
                    const node = current?.nodes.find((item) => item.id === nodeId);
                    if (!node || node.type !== CanvasNodeType.Image || !node.metadata?.storageKey) throw new Error("导演静帧已捕获，但没有回读到持久化图片节点");
                    const resourceId = resourceIdFromStorageKey(String(node.metadata.storageKey));
                    if (!resourceId) throw new Error("导演静帧图片节点缺少持久化 resourceId");
                    const next = { ...snapshotRef.current, nodes: current?.nodes || snapshotRef.current.nodes, connections: current?.connections || snapshotRef.current.connections };
                    snapshotRef.current = next;
                    await postResult({ requestId: payload.requestId, result: { ok: true, canvasId: expectedCanvasId, sceneId, shotId, nodeId, resourceId, storageKey: node.metadata.storageKey, assetId: node.metadata.assetId, captured: "cam_png_still", persisted: true, snapshot: next } });
                    await enqueueStateSync(next);
                    return;
                }
                if (payload.name === "canvas_capture_director_video") {
                    const expectedCanvasId = String(input.expectedCanvasId || "");
                    if (expectedCanvasId !== snapshotRef.current.projectId) throw new Error("请求目标画布与当前画布不一致");
                    const conflict = await canvasToolPreconditionConflict({
                        flushPendingStateSync: () => syncQueueRef.current,
                        readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }),
                        expectedRevision: input.expectedRevision,
                        expectedStateHash: input.expectedStateHash,
                    });
                    if (conflict) throw new Error("画布状态已变化，请重新读取 canvas_get_context 后重试");
                    const sceneId = String(input.sceneId || "");
                    const shotId = String(input.shotId || "");
                    const expectedSceneHash = String(input.expectedSceneHash || "");
                    const durationSeconds = Number(input.durationSeconds);
                    if (!Number.isFinite(durationSeconds) || durationSeconds < 0.5 || durationSeconds > 30) throw new Error("durationSeconds 必须在 0.5 到 30 秒之间");
                    const captured = await captureDirectorVideo({ sceneId, shotId, expectedSceneHash, durationSeconds });
                    if (!(await persistCanvasRef.current())) throw new Error("导演视频已录制，但画布保存失败；请回读确认后再重试");
                    const videoNodeId = captured && typeof captured === "object" && "videoNodeId" in captured && typeof captured.videoNodeId === "string" ? captured.videoNodeId : "";
                    const current = useCanvasStore.getState().projects.find((project) => project.id === expectedCanvasId);
                    const videoNode = current?.nodes.find((node) => node.id === videoNodeId);
                    if (!videoNode || videoNode.type !== CanvasNodeType.Video || !videoNode.metadata?.storageKey) throw new Error("导演视频已录制，但没有回读到持久化视频节点");
                    const resourceId = resourceIdFromStorageKey(String(videoNode.metadata.storageKey));
                    if (!resourceId) throw new Error("导演视频节点仅保存在本地 IndexedDB，未取得服务端 Resource ID；拒绝报告成功");
                    const durationMs = Number(videoNode.metadata.durationMs);
                    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("导演视频已上传，但持久化节点缺少正数的实测时长元数据；拒绝报告成功");
                    const resource = await refreshResource(resourceId);
                    const persistedDurationMs = Number(resource.durationMs);
                    if (!Number.isFinite(persistedDurationMs) || persistedDurationMs <= 0) throw new Error("导演视频已上传，但资源记录仍没有正数时长；拒绝报告成功");
                    if (Math.abs(persistedDurationMs - durationMs) > 1) throw new Error("视频节点实测时长与资源库时长不一致；拒绝报告成功");
                    const report = await probeResource(resourceId, false);
                    if (report.probe.videoStreams < 1 || report.probe.fileSizeBytes < 1) throw new Error("导演视频 Resource 未通过媒体回读校验");
                    if (report.probe.durationMs > 0 && Math.abs(report.probe.durationMs - durationMs) > Math.max(100, durationMs * 0.15)) throw new Error("视频文件探测时长与录制实测时长不一致；拒绝报告成功");
                    const imageNodeId = captured && typeof captured === "object" && "nodeId" in captured && typeof captured.nodeId === "string" ? captured.nodeId : "";
                    const imageNode = imageNodeId ? current?.nodes.find((node) => node.id === imageNodeId) : undefined;
                    if (!imageNode || imageNode.type !== CanvasNodeType.Image || !resourceIdFromStorageKey(String(imageNode.metadata?.storageKey || ""))) throw new Error("导演视频已保存，但配套 CAM 静帧节点未通过持久化回读");
                    const next = { ...snapshotRef.current, nodes: current?.nodes || snapshotRef.current.nodes, connections: current?.connections || snapshotRef.current.connections };
                    snapshotRef.current = next;
                    await postResult({ requestId: payload.requestId, result: { ok: true, canvasId: expectedCanvasId, sceneId, shotId, videoNodeId, resourceId, imageNodeId, durationMs: persistedDurationMs, measuredDurationMs: durationMs, mediaProbeDurationMs: report.probe.durationMs, mimeType: videoNode.metadata.mimeType, captured: "cam_realtime_webm", persisted: true, snapshot: next } });
                    await enqueueStateSync(next);
                    return;
                }
                if (payload.name === "canvas_preflight_storyboard_media") {
                    const current = snapshotRef.current;
                    if (input.canvasId && current.projectId !== input.canvasId) throw new Error("分镜生成预检目标画布与当前标签页不一致");
                    if (input.kind !== "image" && input.kind !== "video") throw new Error("分镜媒体类型必须是 image 或 video");
                    const result = preflightStoryboardMediaRef.current({ nodeId: String(input.nodeId), kind: input.kind, rowIds: input.rowIds as string[] });
                    await postResult({ requestId: payload.requestId, result });
                    return;
                }
                if (payload.name === "canvas_get_timeline") {
                    if (input.projectId !== snapshotRef.current.projectId) throw new Error("时间线目标画布与当前标签页画布不一致");
                    const timeline = await getTimelineRef.current();
                    if (timeline.projectId !== snapshotRef.current.projectId) throw new Error("时间线读取返回了其他画布的数据");
                    await postResult({ requestId: payload.requestId, result: timeline });
                    return;
                }
                if (payload.name === "canvas_list_director_scenes" || payload.name === "canvas_get_director_scene") {
                    const current = snapshotRef.current;
                    if (input.canvasId && input.canvasId !== current.projectId) throw new Error("导演场景读取目标画布与当前标签页不一致");
                    const result = payload.name === "canvas_list_director_scenes"
                        ? { projectId: current.projectId, scenes: directorOperationsRef.current.listScenes() }
                        : { projectId: current.projectId, ...directorOperationsRef.current.readScene({ sceneId: String(input.sceneId) }) };
                    await postResult({ requestId: payload.requestId, result });
                    return;
                }
                if (payload.name === "canvas_create_director_shot") {
                    const before = snapshotRef.current;
                    const created = directorOperationsRef.current.createShot({ templateId: input.templateId as DirectorTemplateId, position: input.position as { x: number; y: number } | undefined });
                    if (!(await persistCanvasRef.current())) throw new Error(`导演镜头 ${created.node.id} 已写入页面但保存失败；请读取导演场景核对，避免重复创建`);
                    const persisted = useCanvasStore.getState().projects.find((project) => project.id === before.projectId);
                    const persistedNode = persisted?.nodes.find((node) => node.id === created.node.id);
                    const persistedScene = persisted?.directorScenes?.find((scene) => scene.id === created.scene.id);
                    if (!persistedNode || persistedNode.metadata?.directorSceneId !== created.scene.id || !persistedScene || hashDirectorScene(persistedScene) !== created.sceneHash) {
                        throw new Error(`导演镜头 ${created.node.id} 保存后节点或场景回读失败；请核对画布，避免重复创建`);
                    }
                    let updated: CanvasSnapshot | undefined;
                    for (let attempt = 0; attempt < 100; attempt += 1) {
                        const current = snapshotRef.current;
                        if (current.projectId !== before.projectId) throw new Error("导演镜头创建期间活动画布已切换");
                        if (current.nodes.some((node) => node.id === created.node.id && node.metadata?.directorSceneId === created.scene.id)) { updated = current; break; }
                        await new Promise((resolve) => window.setTimeout(resolve, 20));
                    }
                    if (!updated) throw new Error(`导演镜头 ${created.node.id} 已保存但页面快照暂未更新；请读取画布核对，避免重复创建`);
                    snapshotRef.current = updated;
                    await enqueueStateSync(updated);
                    await postResult({ requestId: payload.requestId, result: { ok: true, nodeId: created.node.id, sceneId: created.scene.id, sceneHash: created.sceneHash, persisted: true, snapshot: updated } });
                    return;
                }
                if (payload.name === "canvas_update_director_scene" || payload.name === "canvas_update_director_shot") {
                    const projectId = snapshotRef.current.projectId;
                    const operations = directorOperationsRef.current;
                    const scene = payload.name === "canvas_update_director_scene"
                        ? operations.updateSceneParameters({ sceneId: String(input.sceneId), expectedSceneHash: String(input.expectedSceneHash), patch: input.patch as CanvasAgentDirectorScenePatch })
                        : operations.updateShotParameters({ sceneId: String(input.sceneId), shotId: String(input.shotId), expectedSceneHash: String(input.expectedSceneHash), patch: input.patch as CanvasAgentDirectorShotPatch });
                    await flushCanvasStorePersistence();
                    const persistedScene = useCanvasStore.getState().projects.find((project) => project.id === projectId)?.directorScenes?.find((item) => item.id === scene.id);
                    if (snapshotRef.current.projectId !== projectId || !persistedScene || hashDirectorScene(persistedScene) !== hashDirectorScene(scene)) {
                        throw new Error("导演场景修改尚未通过持久化回读；请重新读取场景核对");
                    }
                    await postResult({ requestId: payload.requestId, result: { ok: true, sceneId: scene.id, sceneHash: hashDirectorScene(scene), scene, persisted: true } });
                    return;
                }
                if (["canvas_add_director_camera", "canvas_update_director_camera", "canvas_delete_director_camera", "canvas_add_director_light", "canvas_update_director_light", "canvas_delete_director_light", "canvas_upsert_director_bone_keyframe", "canvas_delete_director_bone_keyframe"].includes(payload.name)) {
                    const projectId = snapshotRef.current.projectId;
                    const operations = directorOperationsRef.current;
                    const sceneId = String(input.sceneId);
                    const expectedSceneHash = String(input.expectedSceneHash);
                    const beforeScene = operations.readScene({ sceneId }).scene;
                    let scene;
                    if (payload.name === "canvas_add_director_camera") {
                        scene = operations.addCamera({ sceneId, expectedSceneHash, name: input.name as string | undefined });
                    } else if (payload.name === "canvas_update_director_camera") {
                        scene = operations.updateCameraParameters({ sceneId, cameraId: String(input.cameraId), expectedSceneHash, patch: input.patch as CanvasAgentDirectorCameraPatch });
                    } else if (payload.name === "canvas_delete_director_camera") {
                        scene = operations.deleteCamera({ sceneId, cameraId: String(input.cameraId), expectedSceneHash });
                    } else if (payload.name === "canvas_add_director_light") {
                        scene = operations.addLight({ sceneId, expectedSceneHash, light: input.light as CanvasAgentDirectorAddLightInput });
                    } else if (payload.name === "canvas_update_director_light") {
                        scene = operations.updateLightParameters({ sceneId, lightId: String(input.lightId), expectedSceneHash, patch: input.patch as CanvasAgentDirectorLightPatch });
                    } else if (payload.name === "canvas_delete_director_light") {
                        scene = operations.deleteLight({ sceneId, lightId: String(input.lightId), expectedSceneHash });
                    } else if (payload.name === "canvas_upsert_director_bone_keyframe") {
                        scene = operations.upsertObjectBoneKeyframe({ sceneId, expectedSceneHash, objectId: String(input.objectId), bone: String(input.bone) as DirectorHumanoidBone, time: Number(input.time), rotation: input.rotation as [number, number, number, number] });
                    } else {
                        scene = operations.removeObjectBoneKeyframe({ sceneId, expectedSceneHash, objectId: String(input.objectId), bone: String(input.bone) as DirectorHumanoidBone, keyframeId: String(input.keyframeId) });
                    }
                    await flushCanvasStorePersistence();
                    const persistedScene = useCanvasStore.getState().projects.find((project) => project.id === projectId)?.directorScenes?.find((item) => item.id === scene.id);
                    if (snapshotRef.current.projectId !== projectId || !persistedScene || hashDirectorScene(persistedScene) !== hashDirectorScene(scene)) {
                        throw new Error("导演摄影机、灯光或骨骼关键帧尚未通过持久化回读；请重新读取场景核对");
                    }
                    const cameraId = payload.name === "canvas_add_director_camera" ? scene.cameras.find((camera) => !beforeScene.cameras.some((item) => item.id === camera.id))?.id : undefined;
                    const lightId = payload.name === "canvas_add_director_light" ? scene.lights.find((light) => !beforeScene.lights.some((item) => item.id === light.id))?.id : undefined;
                    const boneKeyframeId = payload.name === "canvas_upsert_director_bone_keyframe"
                        ? scene.objects.find((object) => object.id === input.objectId)?.boneTracks?.find((track) => track.bone === input.bone)?.keyframes.find((frame) => Math.abs(frame.time - Number(input.time)) < 0.001)?.id
                        : undefined;
                    await postResult({ requestId: payload.requestId, result: { ok: true, sceneId: scene.id, sceneHash: hashDirectorScene(scene), ...(cameraId ? { cameraId } : {}), ...(lightId ? { lightId } : {}), ...(boneKeyframeId ? { keyframeId: boneKeyframeId } : {}), scene, persisted: true } });
                    return;
                }
                if (["canvas_add_director_object", "canvas_update_director_object", "canvas_delete_director_object", "canvas_upsert_director_keyframe", "canvas_delete_director_keyframe"].includes(payload.name)) {
                    const projectId = snapshotRef.current.projectId;
                    const operations = directorOperationsRef.current;
                    const sceneId = String(input.sceneId);
                    const expectedSceneHash = String(input.expectedSceneHash);
                    const beforeScene = operations.readScene({ sceneId }).scene;
                    let scene;
                    if (payload.name === "canvas_add_director_object") {
                        scene = operations.addObject({ sceneId, expectedSceneHash, object: input.object as CanvasAgentDirectorAddObjectInput });
                    } else if (payload.name === "canvas_update_director_object") {
                        scene = operations.updateObjectParameters({ sceneId, objectId: String(input.objectId), expectedSceneHash, patch: input.patch as CanvasAgentDirectorObjectPatch });
                    } else if (payload.name === "canvas_delete_director_object") {
                        scene = operations.deleteObject({ sceneId, objectId: String(input.objectId), expectedSceneHash });
                    } else if (payload.name === "canvas_upsert_director_keyframe") {
                        const target = input.target as { track: "object-transform"; objectId: string } | { track: "camera"; cameraId: string };
                        const keyframeInput = { sceneId, expectedSceneHash, time: Number(input.time), transform: input.transform as CanvasAgentDirectorTransform };
                        scene = target.track === "object-transform"
                            ? operations.upsertObjectKeyframe({ ...keyframeInput, objectId: target.objectId })
                            : operations.upsertCameraKeyframe({ ...keyframeInput, cameraId: target.cameraId });
                    } else {
                        scene = operations.removeKeyframe({ sceneId, expectedSceneHash, target: input.target as { track: "object-transform"; objectId: string; keyframeId: string } | { track: "camera"; cameraId: string; keyframeId: string } });
                    }
                    await flushCanvasStorePersistence();
                    const persistedScene = useCanvasStore.getState().projects.find((project) => project.id === projectId)?.directorScenes?.find((item) => item.id === scene.id);
                    if (snapshotRef.current.projectId !== projectId || !persistedScene || hashDirectorScene(persistedScene) !== hashDirectorScene(scene)) {
                        throw new Error("导演对象或关键帧尚未通过持久化回读；请重新读取场景核对");
                    }
                    const previousObjectIds = new Set(beforeScene.objects.map((object) => object.id));
                    const addedObjectId = payload.name === "canvas_add_director_object" ? scene.objects.find((object) => !previousObjectIds.has(object.id))?.id : undefined;
                    const target = input.target as { track?: string; objectId?: string; cameraId?: string } | undefined;
                    const keyframes = payload.name === "canvas_upsert_director_keyframe"
                        ? target?.track === "object-transform" ? scene.objects.find((object) => object.id === target.objectId)?.keyframes
                            : scene.cameras.find((camera) => camera.id === target?.cameraId)?.keyframes
                        : undefined;
                    const keyframeId = keyframes?.find((keyframe) => Math.abs(keyframe.time - Number(input.time)) < 0.001)?.id;
                    await postResult({ requestId: payload.requestId, result: { ok: true, sceneId: scene.id, sceneHash: hashDirectorScene(scene), ...(addedObjectId ? { objectId: addedObjectId } : {}), ...(keyframeId ? { keyframeId } : {}), scene, persisted: true } });
                    return;
                }
                if (payload.name === "canvas_get_drawing") {
                    const current = snapshotRef.current;
                    if (input.canvasId && input.canvasId !== current.projectId) throw new Error("绘图读取目标画布与当前标签页不一致");
                    const node = current.nodes.find((item) => item.id === input.nodeId);
                    if (!node || node.type !== CanvasNodeType.Drawing || typeof node.metadata?.drawingId !== "string") throw new Error("nodeId 必须指向有真实 drawingId 的绘图节点");
                    const persistedDrawing = await loadCanvasDrawing(current.projectId, node.metadata.drawingId);
                    const drawing = persistedDrawing || (node.metadata.drawingEngine === "excalidraw" ? emptyExcalidrawDrawing() : null);
                    if (!drawing && node.metadata.drawingEngine !== "tldraw") throw new Error("绘图节点对应的文档不存在，且节点未标明可用的绘图引擎");
                    await postResult({ requestId: payload.requestId, result: { nodeId: node.id, drawingId: node.metadata.drawingId, engine: drawing?.engine || "tldraw", revision: drawing?.revision || 0, updatedAt: drawing?.updatedAt || "", shapeCount: drawing?.shapeCount || 0, pageCount: drawing?.pageCount || 1, persisted: Boolean(persistedDrawing), snapshot: drawing ? redactDrawingPayload(drawing.snapshot) : null } });
                    return;
                }
                if (payload.name === "canvas_update_drawing") {
                    const current = snapshotRef.current;
                    const beforeHash = hashCanvasSnapshot(current);
                    if (current.projectId !== input.expectedCanvasId) throw new Error("绘图编辑目标画布已切换");
                    const preconditionConflict = await canvasToolPreconditionConflict({ flushPendingStateSync: () => syncQueueRef.current, readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }), expectedRevision: input.expectedRevision, expectedStateHash: input.expectedStateHash });
                    if (preconditionConflict) throw new Error(preconditionConflict === "revision" ? "画布 revision 已变化，请重新读取 canvas_get_context" : "画布状态哈希已变化，请重新读取 canvas_get_context");
                    const node = current.nodes.find((item) => item.id === input.nodeId);
                    if (!node || node.type !== CanvasNodeType.Drawing || typeof node.metadata?.drawingId !== "string") throw new Error("nodeId 必须指向有真实 drawingId 的绘图节点");
                    const drawing = await loadCanvasDrawing(current.projectId, node.metadata.drawingId)
                        || (node.metadata.drawingEngine === "excalidraw" ? emptyExcalidrawDrawing() : null);
                    if (!drawing) throw new Error("绘图节点对应的文档不存在；仅 Excalidraw 可从空白节点开始编辑");
                    if (drawing.engine !== "excalidraw") throw new Error("当前只支持 Excalidraw 内容编辑；tldraw 编辑尚未接通");
                    if (drawing.revision !== input.expectedDrawingRevision) throw new Error(`绘图 revision 已从 ${input.expectedDrawingRevision} 变为 ${drawing.revision}，请重新读取 canvas_get_drawing 后重试`);
                    const root = drawing.snapshot && typeof drawing.snapshot === "object" ? drawing.snapshot as Record<string, unknown> : {};
                    const elements = Array.isArray(root.elements) ? [...root.elements] as Array<Record<string, unknown>> : [];
                    const operation = input.operation as Record<string, unknown>;
                    if (operation.type === "add_shape") {
                        const shape = String(operation.shape);
                        const draft: Record<string, unknown> = { type: shape === "text" ? "text" : shape, x: operation.x, y: operation.y, ...(typeof operation.width === "number" ? { width: operation.width } : {}), ...(typeof operation.height === "number" ? { height: operation.height } : {}), ...(typeof operation.text === "string" ? { text: operation.text } : {}), ...(typeof operation.strokeColor === "string" ? { strokeColor: operation.strokeColor } : {}), ...(typeof operation.backgroundColor === "string" ? { backgroundColor: operation.backgroundColor } : {}) };
                        const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
                        const created = convertToExcalidrawElements([draft as never]) as unknown as Array<Record<string, unknown>>;
                        if (created.length !== 1 || typeof created[0].id !== "string") throw new Error("Excalidraw 未能创建有效元素");
                        elements.push(created[0]);
                    } else {
                        const targetIndex = elements.findIndex((element) => element.id === operation.elementId && element.isDeleted !== true);
                        if (targetIndex < 0) throw new Error("elementId 不存在或已删除；请先回读绘图快照");
                        if (operation.type === "delete_element") elements[targetIndex] = { ...elements[targetIndex], isDeleted: true, version: Number(elements[targetIndex].version || 0) + 1, versionNonce: Math.floor(Math.random() * 0x7fffffff), updated: Date.now() };
                        else {
                            const patch = operation.patch as Record<string, unknown>;
                            const element = elements[targetIndex];
                            const safePatch = Object.fromEntries(Object.entries(patch).filter(([key]) => ["x", "y", "width", "height", "text", "strokeColor", "backgroundColor"].includes(key)));
                            elements[targetIndex] = { ...element, ...safePatch, version: Number(element.version || 0) + 1, versionNonce: Math.floor(Math.random() * 0x7fffffff), updated: Date.now() };
                        }
                    }
                    const latestConflict = await canvasToolPreconditionConflict({ flushPendingStateSync: () => syncQueueRef.current, readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }), expectedRevision: input.expectedRevision, expectedStateHash: input.expectedStateHash });
                    const latestNode = snapshotRef.current.nodes.find((item) => item.id === node.id);
                    const latestDrawing = await loadCanvasDrawing(current.projectId, node.metadata.drawingId);
                    if (latestConflict || snapshotRef.current.projectId !== current.projectId || hashCanvasSnapshot(snapshotRef.current) !== beforeHash
                        || latestNode?.metadata?.drawingId !== node.metadata.drawingId || (latestDrawing?.revision || 0) !== drawing.revision) {
                        throw new Error("绘图编辑期间画布或绘图文档已变化，请重新读取后重试");
                    }
                    const saved = await saveCanvasDrawing(current.projectId, node.metadata.drawingId, drawing.engine, { ...root, elements }, drawing, null, null);
                    const summary = { ...node.metadata, drawingRevision: saved.revision, drawingShapeCount: saved.shapeCount, drawingPageCount: saved.pageCount, drawingUpdatedAt: saved.updatedAt, drawingPreviewStorageKey: undefined, drawingPreviewUrl: undefined };
                    const updated = await applyOpsRef.current([{ type: "update_node", id: node.id, patch: { metadata: summary } }], { source: "local", conversationId: "codex-mcp", messageId: payload.requestId });
                    if (!(await persistCanvasRef.current())) {
                        throw new Error(`绘图文档 ${node.metadata.drawingId} 已写入但画布保存失败；请读取绘图和节点核对，避免重复修改`);
                    }
                    const persisted = useCanvasStore.getState().projects.find((project) => project.id === current.projectId)?.nodes.find((item) => item.id === node.id);
                    const verified = await loadCanvasDrawing(current.projectId, node.metadata.drawingId);
                    if (!persisted || persisted.metadata?.drawingRevision !== saved.revision || !verified || verified.revision !== saved.revision || verified.shapeCount !== saved.shapeCount) throw new Error("绘图编辑尚未通过文档与画布双重持久化回读");
                    snapshotRef.current = updated;
                    await enqueueStateSync(updated);
                    await postResult({ requestId: payload.requestId, result: { nodeId: node.id, drawingId: node.metadata.drawingId, engine: saved.engine, revision: saved.revision, shapeCount: saved.shapeCount, persisted: true, invalidatedPreviewAndRender: true } });
                    return;
                }
                if (payload.name === "canvas_update_tldraw_drawing") {
                    const current = snapshotRef.current;
                    const beforeHash = hashCanvasSnapshot(current);
                    if (current.projectId !== input.expectedCanvasId) throw new Error("tldraw 编辑目标画布已切换");
                    const licenseKey = useUserStore.getState().drawingEngine.tldrawLicenseKey;
                    if (!isDrawingEngineAvailable("tldraw", licenseKey)) throw new Error("当前便携版未配置有效的 tldraw License Key，不能编辑 tldraw 绘图");
                    const checkCanvasVersion = () => canvasToolPreconditionConflict({
                        flushPendingStateSync: () => syncQueueRef.current,
                        readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }),
                        expectedRevision: input.expectedRevision,
                        expectedStateHash: input.expectedStateHash,
                    });
                    if (await checkCanvasVersion()) throw new Error("画布状态已变化，请重新读取 canvas_get_context");
                    const node = current.nodes.find((item) => item.id === input.nodeId);
                    if (!node || node.type !== CanvasNodeType.Drawing || typeof node.metadata?.drawingId !== "string" || drawingEngineForNode(node) !== "tldraw") throw new Error("nodeId 必须指向 tldraw 绘图节点");
                    const persistedDrawing = await loadCanvasDrawing(current.projectId, node.metadata.drawingId);
                    if (persistedDrawing && persistedDrawing.engine !== "tldraw") throw new Error("绘图文档引擎与节点标记不一致");
                    const drawing = persistedDrawing || { version: 2 as const, engine: "tldraw" as const, snapshot: (await import("tldraw")).createTLStore().getStoreSnapshot(), revision: 0, updatedAt: "", shapeCount: 0, pageCount: 1 };
                    if (drawing.revision !== input.expectedDrawingRevision) throw new Error(`绘图 revision 已从 ${input.expectedDrawingRevision} 变为 ${drawing.revision}，请重新读取 canvas_get_drawing 后重试`);
                    const edited = applyTldrawDrawingOperation(drawing.snapshot, input.operation as TldrawDrawingOperation);
                    const latestNode = snapshotRef.current.nodes.find((item) => item.id === node.id);
                    const latestDrawing = await loadCanvasDrawing(current.projectId, node.metadata.drawingId);
                    if (await checkCanvasVersion() || snapshotRef.current.projectId !== current.projectId || hashCanvasSnapshot(snapshotRef.current) !== beforeHash
                        || latestNode?.metadata?.drawingId !== node.metadata.drawingId || (latestDrawing?.revision || 0) !== drawing.revision) {
                        throw new Error("tldraw 编辑期间画布或文档已变化，请重新读取后重试");
                    }
                    const saved = await saveCanvasDrawing(current.projectId, node.metadata.drawingId, "tldraw", edited.snapshot, drawing, null, null);
                    const summary = { ...node.metadata, drawingRevision: saved.revision, drawingShapeCount: saved.shapeCount, drawingPageCount: saved.pageCount, drawingUpdatedAt: saved.updatedAt, drawingPreviewStorageKey: undefined, drawingPreviewUrl: undefined };
                    const updated = await applyOpsRef.current([{ type: "update_node", id: node.id, patch: { metadata: summary } }], { source: "local", conversationId: "codex-mcp", messageId: payload.requestId });
                    if (!(await persistCanvasRef.current())) throw new Error(`tldraw 文档 ${node.metadata.drawingId} 已写入但画布保存失败；请回读核对，避免重复修改`);
                    const persisted = useCanvasStore.getState().projects.find((project) => project.id === current.projectId)?.nodes.find((item) => item.id === node.id);
                    const verified = await loadCanvasDrawing(current.projectId, node.metadata.drawingId);
                    if (!persisted || persisted.metadata?.drawingRevision !== saved.revision || !verified || verified.revision !== saved.revision || verified.shapeCount !== edited.shapeCount) throw new Error("tldraw 文档与画布未通过持久化回读");
                    snapshotRef.current = updated;
                    await enqueueStateSync(updated);
                    await postResult({ requestId: payload.requestId, result: { nodeId: node.id, drawingId: node.metadata.drawingId, engine: "tldraw", revision: saved.revision, shapeCount: saved.shapeCount, shapeId: edited.shapeId, persisted: true, invalidatedPreviewAndRender: true } });
                    return;
                }
                if (["canvas_create_local_folder", "canvas_create_storyboard_group", "canvas_create_reference_group", "canvas_move_nodes_to_frame"].includes(payload.name)) {
                    const before = snapshotRef.current;
                    if (before.projectId !== input.expectedCanvasId) throw new Error("Frame 操作目标画布已切换");
                    const expectedHash = hashCanvasSnapshot(before);
                    let mutation;
                    const frameOps = frameOperationsRef.current;
                    if (payload.name === "canvas_create_local_folder") mutation = frameOps.createLocalFolder();
                    else if (payload.name === "canvas_create_storyboard_group") mutation = frameOps.createStoryboardGroup(input.nodeIds as string[]);
                    else if (payload.name === "canvas_create_reference_group") mutation = frameOps.createReferenceGroup(input.nodeIds as string[]);
                    else mutation = await frameOps.moveNodes(input.nodeIds as string[], input.targetFrameId as string | null);
                    if (snapshotRef.current.projectId !== before.projectId) throw new Error("Frame 操作期间活动画布已切换");
                    let updated: CanvasSnapshot | undefined;
                    for (let attempt = 0; attempt < 250; attempt += 1) {
                        const current = snapshotRef.current;
                        if (current.projectId !== before.projectId) throw new Error("Frame 操作回读期间活动画布已切换");
                        const actual = current.nodes.filter((node) => mutation.changedNodeIds.includes(node.id));
                        if (actual.length === mutation.changedNodeIds.length && actual.every((node) => JSON.stringify(node) === JSON.stringify(mutation.nodes.find((item) => item.id === node.id)))) { updated = current; break; }
                        await new Promise((resolve) => window.setTimeout(resolve, 20));
                    }
                    if (!updated) throw new Error(`Frame 操作已触发但状态未回读；changedNodeIds=${mutation.changedNodeIds.join(",")}; beforeHash=${expectedHash}. 请读取画布后核对，避免重复执行`);
                    await flushCanvasStorePersistence();
                    const persisted = useCanvasStore.getState().projects.find((project) => project.id === before.projectId);
                    if (!persisted || mutation.changedNodeIds.some((id) => JSON.stringify(persisted.nodes.find((node) => node.id === id)) !== JSON.stringify(mutation.nodes.find((node) => node.id === id)))) throw new Error("Frame 操作尚未通过画布持久化回读");
                    snapshotRef.current = updated;
                    await enqueueStateSync(updated);
                    await postResult({ requestId: payload.requestId, result: { ...mutation, persisted: true, snapshot: updated } });
                    return;
                }
                if (payload.name === "canvas_create_node") {
                    const before = snapshotRef.current;
                    if (before.projectId !== input.expectedCanvasId) throw new Error("节点创建目标画布已切换");
                    const drawingSettings = useUserStore.getState().drawingEngine;
                    assertNativeNodeMetadataAllowed(String(input.nodeType), input.metadata, drawingSettings.tldrawLicenseKey, drawingSettings.defaultEngine);
                    const result = nativeNodeOperationsRef.current.createNode(
                        String(input.nodeType) as never,
                        typeof input.x === "number" && typeof input.y === "number" ? { x: input.x, y: input.y } : undefined,
                        input.workflowProvider === "runninghub" ? "runninghub" : undefined,
                    );
                    if (result.type !== input.nodeType || result.node.id !== result.nodeId) throw new Error("网页原生节点创建返回值不一致");
                    let updated: CanvasSnapshot | undefined;
                    for (let attempt = 0; attempt < 250; attempt += 1) {
                        const current = snapshotRef.current;
                        if (current.projectId !== before.projectId) throw new Error("节点创建期间活动画布已切换");
                        if (current.nodes.some((node) => node.id === result.nodeId && node.type === input.nodeType)) { updated = current; break; }
                        await new Promise((resolve) => window.setTimeout(resolve, 20));
                    }
                    if (!updated) throw new Error(`节点已创建但页面快照尚未回读，nodeId=${result.nodeId}；请先核对后再重试`);
                    const patch: Record<string, unknown> = {};
                    if (typeof input.title === "string") patch.title = input.title;
                    if (typeof input.width === "number") patch.width = input.width;
                    if (typeof input.height === "number") patch.height = input.height;
                    if (input.metadata && typeof input.metadata === "object") patch.metadata = input.metadata;
                    if (Object.keys(patch).length) updated = await applyOpsRef.current([{ type: "update_node", id: result.nodeId, patch }], { source: "local", conversationId: "codex-mcp", messageId: payload.requestId });
                    const createdNode = updated.nodes.find((node) => node.id === result.nodeId);
                    if (createdNode?.type === CanvasNodeType.Drawing && createdNode.metadata?.drawingId) {
                        const drawing = await waitForCanvasDrawingInitialization(updated.projectId, createdNode.metadata.drawingId);
                        if (drawing.engine !== createdNode.metadata.drawingEngine) throw new Error("绘图初始化引擎与节点标记不一致");
                    }
                    await flushCanvasStorePersistence();
                    const persistedProject = useCanvasStore.getState().projects.find((project) => project.id === before.projectId);
                    const persisted = persistedProject?.nodes.find((node) => node.id === result.nodeId);
                    if (!persisted || persisted.type !== input.nodeType || (typeof input.title === "string" && persisted.title !== input.title)) throw new Error(`节点已执行原生创建但持久化回读不完整；nodeId=${result.nodeId}`);
                    if (persistedProject) updated = { ...updated, nodes: persistedProject.nodes };
                    snapshotRef.current = updated;
                    recordAgentOperationRef.current(before, updated, `创建${result.node.title || result.node.type}节点`, [result.nodeId]);
                    await enqueueStateSync(updated);
                    await postResult({ requestId: payload.requestId, result: { ...result, node: persisted, persisted: true, snapshot: updated } });
                    return;
                }
                if (payload.name === "canvas_create_storyboard_image_nodes" || payload.name === "canvas_create_storyboard_video_nodes") {
                    const before = snapshotRef.current;
                    if (before.projectId !== input.expectedCanvasId) throw new Error("分镜媒体节点创建目标画布已切换");
                    const script = before.nodes.find((node) => node.id === input.nodeId);
                    if (!script || script.type !== CanvasNodeType.Script) throw new Error("分镜媒体节点只能绑定到真实 Script 节点");
                    const operations = storyboardNodeOperationsRef.current;
                    const result = payload.name === "canvas_create_storyboard_image_nodes"
                        ? operations.createImageNodes({ nodeId: String(input.nodeId), rowIds: input.rowIds as string[] })
                        : operations.createVideoNodes({ nodeId: String(input.nodeId), rowIds: input.rowIds as string[] });
                    const mediaType = payload.name === "canvas_create_storyboard_image_nodes" ? CanvasNodeType.Image : CanvasNodeType.Video;
                    if (result.nodeId !== script.id || result.items.length !== (input.rowIds as string[]).length || result.items.some((item) => item.node.type !== mediaType)) throw new Error("原生分镜节点创建结果与请求行列表不匹配");
                    const expectedNodeByRow = new Map(result.items.map((item) => [item.rowId, item.nodeId]));
                    let updated: CanvasSnapshot | undefined;
                    for (let attempt = 0; attempt < 250; attempt += 1) {
                        const current = snapshotRef.current;
                        if (current.projectId !== before.projectId) throw new Error("分镜节点创建期间活动画布已切换");
                        const currentScript = current.nodes.find((node) => node.id === script.id && node.type === CanvasNodeType.Script);
                        const rows = currentScript?.metadata?.storyboard?.rows || [];
                        const bound = [...expectedNodeByRow].every(([rowId, nodeId]) => rows.some((row) => row.id === rowId && row[payload.name === "canvas_create_storyboard_image_nodes" ? "imageNodeId" : "videoNodeId"] === nodeId));
                        const nodesReady = result.items.every((item) => current.nodes.some((node) => node.id === item.nodeId && node.type === mediaType));
                        const connectionsReady = result.items.every((item) => current.connections.some((connection) => connection.fromNodeId === script.id && connection.toNodeId === item.nodeId && connection.relation === "storyboard-output" && connection.storyboardRowId === item.rowId));
                        if (bound && nodesReady && connectionsReady) { updated = current; break; }
                        await new Promise((resolve) => window.setTimeout(resolve, 20));
                    }
                    if (!updated) throw new Error(`分镜节点已创建但行绑定尚未回读，nodeIds=${result.nodeIds.join(",")}; 请读取 Script 与画布后再重试`);
                    await flushCanvasStorePersistence();
                    const persisted = useCanvasStore.getState().projects.find((project) => project.id === before.projectId);
                    const persistedScript = persisted?.nodes.find((node) => node.id === script.id && node.type === CanvasNodeType.Script);
                    if (!persisted || !persistedScript || result.items.some((item) => !persisted.nodes.some((node) => node.id === item.nodeId && node.type === mediaType) || !persisted.connections.some((connection) => connection.fromNodeId === script.id && connection.toNodeId === item.nodeId && connection.relation === "storyboard-output" && connection.storyboardRowId === item.rowId)) || [...expectedNodeByRow].some(([rowId, nodeId]) => !(persistedScript.metadata?.storyboard?.rows || []).some((row) => row.id === rowId && row[payload.name === "canvas_create_storyboard_image_nodes" ? "imageNodeId" : "videoNodeId"] === nodeId))) throw new Error(`分镜节点/行绑定/输出连线尚未通过持久化回读：${result.nodeIds.join(",")}`);
                    snapshotRef.current = updated;
                    await enqueueStateSync(updated);
                    await postResult({ requestId: payload.requestId, result: { ...result, persisted: true, snapshot: updated } });
                    return;
                }
                if (payload.name === "canvas_generate_storyboard_rows") {
                    const before = snapshotRef.current;
                    if (before.projectId !== input.expectedCanvasId) throw new Error("AI 拆镜目标画布已切换");
                    const script = before.nodes.find((node) => node.id === input.nodeId && node.type === CanvasNodeType.Script);
                    if (!script) throw new Error("AI 拆镜仅接受真实 Script 节点");
                    const baselineRows = JSON.stringify(script.metadata?.storyboard?.rows || []);
                    const confirmationHash = (value: CanvasSnapshot) => hashCanvasSnapshotForStoryboardConfirmation(value, script.id, script);
                    const beforeHash = confirmationHash(before);
                    const assertStillCurrent = async () => {
                        await syncQueueRef.current;
                        const current = snapshotRef.current;
                        if (current.projectId !== input.expectedCanvasId || current.projectId !== before.projectId) throw new Error("AI 拆镜期间活动画布已切换");
                        const currentScript = current.nodes.find((node) => node.id === script.id && node.type === CanvasNodeType.Script);
                        if (!currentScript || JSON.stringify(currentScript.metadata?.storyboard?.rows || []) !== baselineRows || confirmationHash(current) !== beforeHash) throw new Error("AI 拆镜报价确认期间画布状态已变化，已拒绝提交或覆盖");
                    };
                    await assertStillCurrent();
                    const result = await generateStoryboardRowsRef.current({ nodeId: script.id, prompt: String(input.prompt), clientOperationId: String(input.clientOperationId) }, assertStillCurrent);
                    if (result.nodeId !== script.id || result.clientOperationId !== input.clientOperationId) throw new Error("AI 拆镜返回的画布或幂等 ID 不匹配");
                    if (result.status === "completed") {
                        let updated: CanvasSnapshot | undefined;
                        for (let attempt = 0; attempt < 250; attempt += 1) {
                            const current = snapshotRef.current;
                            if (current.projectId !== before.projectId) throw new Error("AI 拆镜完成后活动画布已切换");
                            const currentScript = current.nodes.find((node) => node.id === script.id && node.type === CanvasNodeType.Script);
                            if (JSON.stringify(currentScript?.metadata?.storyboard?.rows || []) === JSON.stringify(result.rows)) { updated = current; break; }
                            await new Promise((resolve) => window.setTimeout(resolve, 20));
                        }
                        if (!updated) throw new Error(`拆镜任务已完成但页面行状态未回读；clientOperationId=${result.clientOperationId}；请使用相同 ID 恢复，勿重复确认`);
                        await flushCanvasStorePersistence();
                        const persistedScript = useCanvasStore.getState().projects.find((project) => project.id === before.projectId)?.nodes.find((node) => node.id === script.id && node.type === CanvasNodeType.Script);
                        if (!persistedScript || JSON.stringify(persistedScript.metadata?.storyboard?.rows || []) !== JSON.stringify(result.rows)) throw new Error(`拆镜行尚未通过持久化回读；clientOperationId=${result.clientOperationId}`);
                        snapshotRef.current = updated;
                        await enqueueStateSync(updated);
                    } else {
                        let latest: CanvasSnapshot | undefined;
                        for (let attempt = 0; attempt < 250; attempt += 1) {
                            const current = snapshotRef.current;
                            if (current.projectId !== before.projectId) throw new Error("AI 拆镜结束时活动画布已切换");
                            const currentScript = current.nodes.find((node) => node.id === script.id && node.type === CanvasNodeType.Script);
                            if (currentScript?.metadata?.taskClientOperationId === result.clientOperationId) { latest = current; break; }
                            await new Promise((resolve) => window.setTimeout(resolve, 20));
                        }
                        if (!latest) throw new Error(`AI 拆镜状态未能回读；clientOperationId=${result.clientOperationId}。请用相同 ID 恢复原任务`);
                        await flushCanvasStorePersistence();
                        const persistedScript = useCanvasStore.getState().projects.find((project) => project.id === before.projectId)?.nodes.find((node) => node.id === script.id && node.type === CanvasNodeType.Script);
                        if (persistedScript?.metadata?.taskClientOperationId !== result.clientOperationId) throw new Error(`AI 拆镜状态尚未持久化；clientOperationId=${result.clientOperationId}`);
                        snapshotRef.current = latest;
                        await enqueueStateSync(latest);
                    }
                    await postResult({ requestId: payload.requestId, result });
                    return;
                }
                if (payload.name === "canvas_generate_storyboard_media") {
                    const before = snapshotRef.current;
                    if (before.projectId !== input.expectedCanvasId) throw new Error("分镜媒体生成目标画布已切换");
                    if (input.kind !== "image" && input.kind !== "video") throw new Error("分镜媒体类型必须是 image 或 video");
                    const script = before.nodes.find((node) => node.id === input.nodeId && node.type === CanvasNodeType.Script);
                    if (!script) throw new Error("分镜媒体生成仅接受真实 Script 节点");
                    const beforeHash = hashCanvasSnapshot(before);
                    const assertStillCurrent = async () => {
                        const conflict = await canvasToolPreconditionConflict({
                            flushPendingStateSync: () => syncQueueRef.current,
                            readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }),
                            expectedRevision: input.expectedRevision,
                            expectedStateHash: input.expectedStateHash,
                        });
                        const current = snapshotRef.current;
                        if (conflict || current.projectId !== before.projectId || hashCanvasSnapshot(current) !== beforeHash) {
                            throw new Error("分镜媒体报价确认期间画布状态已变化，已拒绝提交或覆盖");
                        }
                    };
                    await assertStillCurrent();
                    const result = await generateStoryboardMediaRef.current({
                        nodeId: script.id,
                        kind: input.kind,
                        rowIds: input.rowIds as string[],
                        clientOperationId: String(input.clientOperationId),
                    }, assertStillCurrent);
                    if (result.nodeId !== script.id || result.clientOperationId !== input.clientOperationId) throw new Error("分镜媒体生成返回的节点或幂等 ID 不匹配");
                    if (!result.batchId) {
                        await postResult({ requestId: payload.requestId, result });
                        return;
                    }
                    let updated: CanvasSnapshot | undefined;
                    for (let attempt = 0; attempt < 250; attempt += 1) {
                        const current = snapshotRef.current;
                        if (current.projectId !== before.projectId) throw new Error("分镜媒体生成期间活动画布已切换");
                        const currentScript = current.nodes.find((node) => node.id === script.id && node.type === CanvasNodeType.Script);
                        const batch = currentScript?.metadata?.generationBatches?.find((item) => item.id === result.batchId);
                        const currentRows = currentScript?.metadata?.storyboard?.rows || [];
                        const bound = result.rows.every((item) => !item.nodeId || currentRows.some((row) => row.id === item.rowId && (input.kind === "image" ? row.imageNodeId : row.videoNodeId) === item.nodeId && current.nodes.some((node) => node.id === item.nodeId)));
                        if (batch && bound) { updated = current; break; }
                        await new Promise((resolve) => window.setTimeout(resolve, 20));
                    }
                    if (!updated) throw new Error(`分镜批次可能已入队但状态未回读；clientOperationId=${result.clientOperationId}。请查询同一 ID 的批次，勿更换 ID 重发`);
                    await flushCanvasStorePersistence();
                    const persisted = useCanvasStore.getState().projects.find((project) => project.id === before.projectId);
                    const persistedScript = persisted?.nodes.find((node) => node.id === script.id && node.type === CanvasNodeType.Script);
                    const persistedBatch = persistedScript?.metadata?.generationBatches?.find((item) => item.id === result.batchId);
                    if (!persisted || !persistedBatch || result.rows.some((item) => item.nodeId && !(persistedScript?.metadata?.storyboard?.rows || []).some((row) => row.id === item.rowId && (input.kind === "image" ? row.imageNodeId : row.videoNodeId) === item.nodeId && persisted.nodes.some((node) => node.id === item.nodeId)))) {
                        throw new Error(`分镜批次及行媒体绑定尚未通过持久化回读；clientOperationId=${result.clientOperationId}。请用同一 ID 恢复`);
                    }
                    snapshotRef.current = updated;
                    await enqueueStateSync(updated);
                    await postResult({ requestId: payload.requestId, result: { ...result, persisted: true, snapshot: updated } });
                    return;
                }
                if (payload.name === "canvas_list_projects") {
                    await postResult({ requestId: payload.requestId, result: await listAgentCanvasProjects() });
                    return;
                }
                if (payload.name === "canvas_export_projects") {
                    const result = await downloadAgentCanvasProjects({ projectIds: input.projectIds as string[], expectedRevisions: input.expectedRevisions as Record<string, { revision: number; updatedAt: string; contentHash: string }> });
                    await postResult({ requestId: payload.requestId, result });
                    return;
                }
                if (payload.name === "canvas_apply_timeline_operation") {
                    if (input.projectId !== snapshotRef.current.projectId) throw new Error("时间线目标画布与当前标签页画布不一致");
                    const operation = input.operation as CanvasAgentTimelineOperation;
                    const result = await applyTimelineOperationRef.current(String(input.expectedHash || ""), operation);
                    if (result.projectId !== snapshotRef.current.projectId || result.snapshot.projectId !== snapshotRef.current.projectId) throw new Error("时间线写操作返回了其他画布的数据");
                    snapshotRef.current = result.snapshot;
                    await postResult({ requestId: payload.requestId, result });
                    await enqueueStateSync(result.snapshot);
                    return;
                }
                if (payload.name === "canvas_upload_file" || payload.name === "canvas_import_project_archive") {
                    const before = snapshotRef.current;
                    const uploadId = typeof input.uploadId === "string" ? input.uploadId : "";
                    const fileName = typeof input.fileName === "string" ? input.fileName : "";
                    const mimeType = typeof input.mimeType === "string" ? input.mimeType : "";
                    const expectedSize = typeof input.size === "number" ? input.size : -1;
                    if (!uploadId || !fileName || !mimeType || expectedSize <= 0 || expectedSize > 100 * 1024 * 1024) throw new Error("本机文件上传请求缺少有效传输信息");
                    const targetNodeId = typeof input.nodeId === "string" ? input.nodeId : undefined;
                    const target = targetNodeId ? before.nodes.find((node) => node.id === targetNodeId) : undefined;
                    if (targetNodeId && !target) throw new Error(`替换目标节点不存在：${targetNodeId}`);
                    const position = target?.position || { x: typeof input.x === "number" ? input.x : 0, y: typeof input.y === "number" ? input.y : 0 };
                    const assertStillCurrent = async () => {
                        await syncQueueRef.current;
                        const current = snapshotRef.current;
                        if (current.projectId !== input.expectedCanvasId) throw new Error("上传期间活动画布已切换");
                        const conflict = await canvasToolPreconditionConflict({
                            flushPendingStateSync: () => syncQueueRef.current,
                            readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }),
                            expectedRevision: input.expectedRevision,
                            expectedStateHash: input.expectedStateHash,
                        });
                        if (conflict) throw new Error("文件传输期间画布已变化，请重新读取 canvas_get_context 后重试");
                        if (targetNodeId) {
                            const latestTarget = current.nodes.find((node) => node.id === targetNodeId);
                            if (!latestTarget || JSON.stringify(latestTarget) !== JSON.stringify(target)) throw new Error("替换目标节点在上传期间已被修改；已拒绝覆盖");
                        }
                    };
                    await assertStillCurrent();
                    const response = await getLocalRuntimeSessionClient().request(`/canvas/uploads/${encodeURIComponent(uploadId)}?clientId=${encodeURIComponent(clientIdRef.current)}`);
                    if (!response.ok) throw new Error(`本机文件传输失败（HTTP ${response.status}）`);
                    const responseMimeType = (response.headers.get("content-type") || "").split(";", 1)[0];
                    const responseSize = Number(response.headers.get("content-length"));
                    if (responseMimeType !== mimeType.split(";", 1)[0] || responseSize !== expectedSize) throw new Error("本机文件传输的 MIME 或大小与预检结果不一致");
                    const blob = await response.blob();
                    if (blob.size !== expectedSize) throw new Error("接收文件大小校验失败");
                    await assertStillCurrent();
                    if (payload.name === "canvas_import_project_archive") {
                        if (responseMimeType !== "application/zip" || blob.size < 4 || blob.size > 100 * 1024 * 1024) throw new Error("导入文件必须是 100 MiB 内的 ZIP");
                        const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
                        if (!(signature[0] === 0x50 && signature[1] === 0x4b && [[0x03, 0x04], [0x05, 0x06], [0x07, 0x08]].some(([a,b]) => signature[2] === a && signature[3] === b))) throw new Error("ZIP 文件签名无效");
                        const result = await importAgentCanvasProjectArchive({ file: blob, preferLocal: input.preferLocal === true });
                        await postResult({ requestId: payload.requestId, result });
                        return;
                    }
                    const file = new File([blob], fileName, { type: mimeType.split(";", 1)[0], lastModified: Date.now() });
                    const nodeId = await uploadLocalFileRef.current(file, targetNodeId, position, assertStillCurrent);
                    if (!nodeId) throw new Error("原生上传流程未返回已保存节点 ID");
                    let updated: CanvasSnapshot | undefined;
                    for (let attempt = 0; attempt < 150; attempt += 1) {
                        const current = snapshotRef.current;
                        if (current.projectId !== before.projectId) throw new Error("上传期间画布已切换，拒绝返回其他画布的结果");
                        const node = current.nodes.find((item) => item.id === nodeId);
                        if (node && resourceIdFromStorageKey(String(node.metadata?.storageKey || "")) && node.metadata?.assetId) { updated = current; break; }
                        await new Promise((resolve) => window.setTimeout(resolve, 20));
                    }
                    if (!updated) throw new Error("Resource/Asset 上传已完成但页面状态未回读确认，请重新读取画布核对");
                    if (targetNodeId && (nodeId !== targetNodeId || !target)) throw new Error("原生替换流程返回了错误的节点 ID");
                    snapshotRef.current = updated;
                    await postResult({ requestId: payload.requestId, result: { ok: true, canvasId: updated.projectId, nodeId, assetId: updated.nodes.find((node) => node.id === nodeId)?.metadata?.assetId, resourceId: resourceIdFromStorageKey(String(updated.nodes.find((node) => node.id === nodeId)?.metadata?.storageKey || "")), fileName, mimeType, bytes: blob.size, snapshot: updated } });
                    await enqueueStateSync(updated);
                    return;
                }
                if (["canvas_preflight_image_edit", "canvas_edit_image", "canvas_analyze_image", "canvas_annotate_image", "canvas_decompose_image", "canvas_create_panorama_viewer", "canvas_save_node_asset", "canvas_image_node_action"].includes(payload.name)) {
                    const before = snapshotRef.current;
                    const source = before.nodes.find((node) => node.id === input.nodeId);
                    if (!source) throw new Error("图片工具源节点不存在");
                    const sourceIdentity = JSON.stringify(source);
                    const beforeCommit = async () => {
                        if (snapshotRef.current.projectId !== before.projectId) throw new Error("图片工具处理期间活动画布已切换");
                        const conflict = await canvasToolPreconditionConflict({ flushPendingStateSync: () => syncQueueRef.current, readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }), expectedRevision: input.expectedRevision, expectedStateHash: input.expectedStateHash });
                        if (conflict || JSON.stringify(snapshotRef.current.nodes.find((node) => node.id === source.id)) !== sourceIdentity) throw new Error("图片工具提交前画布/源图已变化，请重新读取画布");
                    };
                    const image = imageOperationsRef.current;
                    let result: Record<string, unknown>;
                    if (payload.name === "canvas_preflight_image_edit") {
                        await postResult({ requestId: payload.requestId, result: image.preflight(input as unknown as ImageEditInput) });
                        return;
                    }
                    await beforeCommit();
                    if (payload.name === "canvas_edit_image") result = await image.edit(input as unknown as ImageEditInput, beforeCommit);
                    else if (payload.name === "canvas_analyze_image") result = await image.analyze(input as unknown as ImageAnalyzeInput, beforeCommit);
                    else if (payload.name === "canvas_annotate_image") result = await image.annotate(input as never, beforeCommit);
                    else if (payload.name === "canvas_decompose_image") result = await image.decompose(input as unknown as ImageDecomposeInput, beforeCommit);
                    else if (payload.name === "canvas_save_node_asset") result = await image.saveAsset({ nodeId: source.id }, beforeCommit);
                    else if (payload.name === "canvas_image_node_action") result = await imageNodeActionRef.current(source.id, input.action as never);
                    else {
                        if (source.type !== CanvasNodeType.Image || !source.metadata?.content) throw new Error("全景查看需要实际图片");
                        const projection = input.projection === "cylindrical" ? "cylindrical" : "spherical";
                        const child = createPanoramaViewerRef.current(source, source.metadata.prompt || "", { projection, sourceMode: "image", smartBase: false, directImageUrl: source.metadata.content, referenceImages: [] });
                        result = { accepted: true, nodeId: child.id, createdNodeIds: [child.id], sourceNodeId: source.id, projection, paidRequestSubmitted: false, warnings: ["创建的是原图全景投影视图，未重建照片中不可见的空间。"] };
                    }
                    const createdIds = (Array.isArray(result.createdNodeIds) ? result.createdNodeIds : []) as string[];
                    let updated = snapshotRef.current;
                    if (createdIds.length) {
                        let confirmed = false;
                        for (let attempt = 0; attempt < 150; attempt++) {
                            updated = snapshotRef.current;
                            if (updated.projectId !== before.projectId) throw new Error("图片工具已提交，但当前画布已切换；按返回任务查询，勿重复付费");
                            if (createdIds.every((id) => updated.nodes.some((node) => node.id === id))) { confirmed = true; break; }
                            await new Promise((resolve) => window.setTimeout(resolve, 20));
                        }
                        if (!confirmed) throw new Error(`图片工具输出回读未确认：${createdIds.join(", ")}；先查原任务和节点，勿重复提交`);
                    }
                    await flushCanvasStorePersistence();
                    if (createdIds.length) recordAgentOperationRef.current(before, updated, "MCP 图片工具", [source.id, ...createdIds]);
                    await enqueueStateSync(updated);
                    await postResult({ requestId: payload.requestId, result: { ...result, snapshot: updated } });
                    return;
                }
                if (["canvas_crop_image", "canvas_split_image", "canvas_upscale_image", "canvas_extract_video_frames", "canvas_extract_video_audio", "canvas_trim_video"].includes(payload.name)) {
                    const before = snapshotRef.current;
                    if (before.projectId !== input.expectedCanvasId) throw new Error("媒体操作目标画布已切换");
                    const nodeId = String(input.nodeId || "");
                    const source = before.nodes.find((node) => node.id === nodeId);
                    if (!source) throw new Error(`媒体源节点不存在：${nodeId}`);
                    const assertBeforeOperation = async () => {
                        await syncQueueRef.current;
                        if (snapshotRef.current.projectId !== before.projectId) throw new Error("媒体操作期间活动画布已切换");
                        const conflict = await canvasToolPreconditionConflict({ flushPendingStateSync: () => syncQueueRef.current, readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }), expectedRevision: input.expectedRevision, expectedStateHash: input.expectedStateHash });
                        if (conflict) throw new Error("媒体操作前画布状态已变化，请重新读取后重试");
                        const currentSource = snapshotRef.current.nodes.find((node) => node.id === nodeId);
                        if (!currentSource || JSON.stringify(currentSource) !== JSON.stringify(source)) throw new Error("媒体源节点在操作前已变化，拒绝处理");
                    };
                    const assertBeforeMediaCommit = async () => {
                        await assertBeforeOperation();
                    };
                    await assertBeforeOperation();
                    let result;
                    const media = mediaOperationsRef.current;
                    if (payload.name === "canvas_crop_image") result = await media.cropImage({ nodeId, crop: input.crop as never, beforeCommit: assertBeforeMediaCommit });
                    else if (payload.name === "canvas_split_image") result = await media.splitImage({ nodeId, params: input.params as never, beforeCommit: assertBeforeMediaCommit });
                    else if (payload.name === "canvas_upscale_image") result = await media.upscaleImage({ nodeId, params: input.params as never, beforeCommit: assertBeforeMediaCommit });
                    else if (payload.name === "canvas_extract_video_frames") result = await media.extractVideoFrames({ nodeId, params: input.params as never, beforeCommit: assertBeforeMediaCommit });
                    else if (payload.name === "canvas_extract_video_audio") result = await media.extractVideoAudio({ nodeId, startMs: Number(input.startMs), endMs: Number(input.endMs), beforeCommit: assertBeforeMediaCommit });
                    else result = await media.trimVideo({ nodeId, segments: input.segments as Array<{ startMs: number; endMs: number }>, beforeCommit: assertBeforeMediaCommit });
                    if (!result.createdNodes.length) throw new Error("媒体操作未生成可回读节点；处理可能已中止，先检查页面状态再决定是否重试");
                    if (result.projectId !== before.projectId || snapshotRef.current.projectId !== before.projectId) throw new Error("媒体操作返回了其他画布状态");
                    let updated: CanvasSnapshot | undefined;
                    const createdIds = new Set(result.createdNodes.map((node) => node.id));
                    for (let attempt = 0; attempt < 250; attempt += 1) {
                        const latest = snapshotRef.current;
                        if (latest.projectId !== before.projectId) throw new Error("媒体产物回读期间画布已切换");
                        if ([...createdIds].every((id) => latest.nodes.some((node) => node.id === id))) { updated = latest; break; }
                        await new Promise((resolve) => window.setTimeout(resolve, 40));
                    }
                    if (!updated) throw new Error(`媒体处理可能已创建产物但页面尚未回读，节点 ID：${[...createdIds].join(", ") || "未返回"}；先读取画布核对后再重试`);
                    await flushCanvasStorePersistence();
                    const persisted = useCanvasStore.getState().projects.find((project) => project.id === updated!.projectId);
                    const missingDurable = [...createdIds].filter((id) => !persisted?.nodes.some((node) => node.id === id));
                    const unpersistedAssets = result.createdNodes.filter((node) => !node.assetPersisted);
                    const warnings = [...result.warnings];
                    if (missingDurable.length) warnings.push(`本地持久化回读未确认节点：${missingDurable.join(", ")}`);
                    if (unpersistedAssets.length) warnings.push(`部分产物没有已确认 Asset：${unpersistedAssets.map((node) => node.id).join(", ")}`);
                    const finalResult = { ...result, partial: result.partial || missingDurable.length > 0 || unpersistedAssets.length > 0, warnings, snapshot: updated };
                    await postResult({ requestId: payload.requestId, result: finalResult });
                    await enqueueStateSync(updated);
                    return;
                }
                if (payload.name === "canvas_convert_media") {
                    const before = snapshotRef.current;
                    const nodeId = String(input.nodeId);
                    const operation = input.operation as MediaConversionOperation;
                    const target = before.nodes.find((node) => node.id === nodeId);
                    if (!target || target.type !== CanvasNodeType.MediaConversion) throw new Error("只能对真实转换节点执行转换");
                    if (activeConversionIdsRef.current.has(nodeId)) throw new Error("这个转换节点已有正在运行的任务，请等待完成");
                    const sourceIds = [...new Set(before.connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId))];
                    if (sourceIds.length !== 1) throw new Error(sourceIds.length ? "转换节点只能连接一个图片或视频输入" : "请先给转换节点连接一张图片或一个视频");
                    const source = before.nodes.find((node) => node.id === sourceIds[0]);
                    if (!source || (source.type !== CanvasNodeType.Image && source.type !== CanvasNodeType.Video)) throw new Error("转换节点只接受图片或视频输入");
                    const sourceKind = source.type === CanvasNodeType.Video ? "video" : "image";
                    if (sourceKind === "image" && input.videoFrameTimeSeconds !== undefined) throw new Error("图片转换不需要取帧时间");
                    const videoFrameTimeSeconds = sourceKind === "video" ? (typeof input.videoFrameTimeSeconds === "number" ? input.videoFrameTimeSeconds : target.metadata?.mediaConversion?.videoFrameTimeSeconds || 0) : 0;
                    const sourceFingerprint = `${mediaConversionSourceFingerprint(source)}${sourceKind === "video" ? `|frame:${videoFrameTimeSeconds}` : ""}`;
                    const originalConversion = JSON.stringify(target.metadata?.mediaConversion);
                    const assertStillCurrent = () => {
                        const current = snapshotRef.current;
                        if (current.projectId !== before.projectId) throw new Error("转换期间活动画布已切换，结果未写入");
                        const latestTarget = current.nodes.find((node) => node.id === nodeId && node.type === CanvasNodeType.MediaConversion);
                        const latestSource = current.nodes.find((node) => node.id === source.id);
                        const latestSourceIds = [...new Set(current.connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId))];
                        if (!latestTarget || !latestSource || latestSourceIds.length !== 1 || latestSourceIds[0] !== source.id || mediaConversionSourceFingerprint(latestSource) !== mediaConversionSourceFingerprint(source) || JSON.stringify(latestTarget.metadata?.mediaConversion) !== originalConversion) throw new Error("转换期间输入或节点设置已改变，结果未写入；请重新读取画布后重试");
                        return latestTarget;
                    };
                    activeConversionIdsRef.current.add(nodeId);
                    try {
                        const fallback = sourceKind === "video" ? source.metadata?.content || source.metadata?.previewContent || "" : source.metadata?.previewContent || source.metadata?.content || "";
                        const sourceUrl = sourceKind === "video" ? await resolveMediaUrl(source.metadata?.storageKey, fallback) : await resolveImageUrl(source.metadata?.storageKey, fallback, { cacheMiss: true });
                        if (!sourceUrl) throw new Error("输入媒体尚未准备好，请检查源节点资源");
                        const startedAt = new Date().toISOString();
                        const conversion = await executeMediaConversion({ sourceUrl, sourceKind, operation, videoFrameTimeSeconds, signal: new AbortController().signal });
                        const latestTarget = assertStillCurrent();
                        const storageKey = localConversionStorageKey(nodeId, sourceFingerprint, operation);
                        await setImageBlob(storageKey, conversion.blob);
                        const nextConversion = {
                            ...(latestTarget.metadata?.mediaConversion || createDefaultMediaConversionState()),
                            schemaVersion: 1 as const,
                            operation,
                            status: "completed" as const,
                            sourceNodeId: source.id,
                            sourceFingerprint,
                            outputKind: "image" as const,
                            videoFrameTimeSeconds,
                            resultStorageKey: storageKey,
                            resultWidth: conversion.width,
                            resultHeight: conversion.height,
                            detectedPeople: conversion.detectedPeople,
                            errorCode: undefined,
                            errorMessage: undefined,
                            startedAt,
                            updatedAt: new Date().toISOString(),
                        };
                        const metadata = {
                            ...latestTarget.metadata,
                            content: "",
                            previewContent: "",
                            storageKey,
                            mimeType: conversion.blob.type || "image/png",
                            bytes: conversion.blob.size,
                            naturalWidth: conversion.width,
                            naturalHeight: conversion.height,
                            mediaConversion: nextConversion,
                        };
                        assertStillCurrent();
                        const ops: CanvasOperation[] = [{ type: "update_node", id: nodeId, patch: { metadata } }];
                        const updated = await applyOpsRef.current(ops, { source: "local", conversationId: "codex-mcp", messageId: payload.requestId });
                        const verification = verifyCanvasOperations(before, updated, ops);
                        if (!verification.ok) throw new Error(canvasOperationPostconditionMessage(verification));
                        let observed: CanvasSnapshot | undefined;
                        for (let attempt = 0; attempt < 250; attempt += 1) {
                            const latest = snapshotRef.current;
                            if (latest.projectId !== before.projectId) throw new Error("转换结果回读期间画布已切换");
                            if (latest.nodes.find((node) => node.id === nodeId)?.metadata?.mediaConversion?.resultStorageKey === storageKey) { observed = latest; break; }
                            await new Promise((resolve) => window.setTimeout(resolve, 20));
                        }
                        if (!observed) throw new Error("转换结果已写入，但页面尚未回读；请先检查节点，避免重复运行");
                        if (!(await persistCanvasRef.current())) throw new Error("转换结果已写入页面，但画布保存失败；请先检查节点，避免重复运行");
                        await flushCanvasStorePersistence();
                        const persisted = useCanvasStore.getState().projects.find((project) => project.id === before.projectId)?.nodes.find((node) => node.id === nodeId);
                        if (persisted?.metadata?.mediaConversion?.resultStorageKey !== storageKey || persisted.metadata.mediaConversion.status !== "completed") throw new Error("转换结果尚未通过画布持久化回读；请先检查节点，避免重复运行");
                        snapshotRef.current = observed;
                        await enqueueStateSync(observed);
                        await postResult({ requestId: payload.requestId, result: { ok: true, nodeId, sourceNodeId: source.id, operation, resultStorageKey: storageKey, width: conversion.width, height: conversion.height, detectedPeople: conversion.detectedPeople, persisted: true, snapshot: observed } });
                        return;
                    } finally {
                        activeConversionIdsRef.current.delete(nodeId);
                    }
                }
                if (payload.name === "canvas_edit_reference") {
                    const before = snapshotRef.current;
                    const targetNodeId = String(input.targetNodeId ?? "");
                    const sourceNodeId = String(input.sourceNodeId ?? "");
                    const operation: CanvasAgentReferenceOperation = input.operation === "add"
                        ? { operation: "add", targetNodeId, sourceNodeId, connectionId: nanoid() }
                        : input.operation === "remove"
                            ? { operation: "remove", targetNodeId, sourceNodeId }
                            : input.operation === "replace"
                                ? { operation: "replace", targetNodeId, sourceNodeId, oldSourceNodeId: String(input.oldSourceNodeId ?? "") }
                                : input.operation === "reorder" && Array.isArray(input.sourceNodeIds) && input.sourceNodeIds.every((value) => typeof value === "string")
                                    ? { operation: "reorder", targetNodeId, sourceNodeIds: input.sourceNodeIds as string[] }
                                    : (() => { throw new Error("不支持的参考操作或来源节点列表无效"); })();
                    const result = editReferenceRef.current(operation);
                    const referenceReadbackMatches = (nodes: CanvasNodeData[], connections: CanvasSnapshot["connections"]) => {
                        const target = nodes.find((node) => node.id === targetNodeId);
                        const expectedTarget = result.nodes.find((node) => node.id === targetNodeId);
                        const references = buildCanvasNodeMentionReferenceMap(nodes, connections).get(targetNodeId) || [];
                        return Boolean(target && expectedTarget
                            && JSON.stringify(connections) === JSON.stringify(result.connections)
                            && (target.metadata?.composerContent ?? target.metadata?.prompt ?? "") === result.composerContent
                            && JSON.stringify(references.map(({ nodeId, label, kind }) => ({ nodeId, label, kind }))) === JSON.stringify(result.references));
                    };
                    let updated: CanvasSnapshot | undefined;
                    for (let attempt = 0; attempt < 250; attempt += 1) {
                        const current = snapshotRef.current;
                        if (current.projectId !== before.projectId) throw new Error("参考操作期间活动画布已切换；请重新读取画布状态");
                        if (referenceReadbackMatches(current.nodes, current.connections)) {
                            updated = current;
                            break;
                        }
                        await new Promise((resolve) => window.setTimeout(resolve, 20));
                    }
                    if (!updated) throw new Error("参考操作已提交，但画布状态尚未回读；请读取画布核对，避免重复操作");
                    if (hashCanvasSnapshot(updated) === hashCanvasSnapshot(before)) throw new Error("参考操作没有产生可验证的画布变化");
                    await flushCanvasStorePersistence();
                    const persisted = useCanvasStore.getState().projects.find((project) => project.id === updated!.projectId);
                    if (!persisted || !referenceReadbackMatches(persisted.nodes, persisted.connections)) {
                        throw new Error("参考操作尚未通过持久化回读；请读取画布核对，避免重复操作");
                    }
                    snapshotRef.current = updated;
                    await enqueueStateSync(updated);
                    await postResult({ requestId: payload.requestId, result: {
                        operation: operation.operation,
                        targetNodeId,
                        composerContent: result.composerContent,
                        references: result.references,
                        persisted: true,
                        snapshot: updated,
                    } });
                    return;
                }
                if (payload.name === "canvas_preflight_batch_rows") {
                    const current = snapshotRef.current;
                    if (input.canvasId && current.projectId !== input.canvasId) throw new Error("批量行预检目标画布与当前标签页不一致");
                    const result = preflightBatchRowsRef.current({ nodeId: String(input.nodeId), rowIds: input.rowIds as string[] });
                    await postResult({ requestId: payload.requestId, result });
                    return;
                }
                if (payload.name === "canvas_generate_batch_rows") {
                    const before = snapshotRef.current;
                    if (before.projectId !== input.expectedCanvasId) throw new Error("批量行生成目标画布已切换");
                    const source = before.nodes.find((node) => node.id === input.nodeId && node.type === CanvasNodeType.BatchTable);
                    if (!source?.metadata?.batchTable) throw new Error("批量行生成仅接受真实批量创作表");
                    const beforeHash = hashCanvasSnapshot(before);
                    const assertStillCurrent = async () => {
                        const conflict = await canvasToolPreconditionConflict({
                            flushPendingStateSync: () => syncQueueRef.current,
                            readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }),
                            expectedRevision: input.expectedRevision,
                            expectedStateHash: input.expectedStateHash,
                        });
                        const current = snapshotRef.current;
                        if (conflict || current.projectId !== before.projectId || hashCanvasSnapshot(current) !== beforeHash) {
                            throw new Error("批量行报价确认期间画布状态已变化，已拒绝提交或覆盖");
                        }
                    };
                    await assertStillCurrent();
                    const result = await generateBatchRowsRef.current({
                        nodeId: source.id,
                        rowIds: input.rowIds as string[],
                        clientOperationId: String(input.clientOperationId),
                    }, assertStillCurrent) as { nodeId: string; clientOperationId: string; batchId?: string; rows: Array<{ rowId: string; nodeId?: string }> };
                    if (result.nodeId !== source.id || result.clientOperationId !== input.clientOperationId) throw new Error("批量行生成返回的节点或幂等 ID 不匹配");
                    if (!result.batchId) {
                        await postResult({ requestId: payload.requestId, result });
                        return;
                    }
                    const hasBatchBindings = (current: CanvasSnapshot) => {
                        const currentSource = current.nodes.find((node) => node.id === source.id && node.type === CanvasNodeType.BatchTable);
                        const batch = currentSource?.metadata?.generationBatches?.find((item) => item.id === result.batchId && item.clientOperationId === result.clientOperationId);
                        const rows = currentSource?.metadata?.batchTable?.rows || [];
                        return Boolean(batch && batch.items.every((item) => {
                            const row = rows.find((candidate) => candidate.id === item.rowId);
                            return row?.outputNodeId === item.nodeId
                                && current.nodes.some((node) => node.id === item.nodeId && node.type === CanvasNodeType.Image)
                                && current.connections.some((connection) => connection.fromNodeId === source.id && connection.toNodeId === item.nodeId && connection.relation === "batch-output" && connection.storyboardRowId === item.rowId)
                                && row.inputNodeIds.filter(Boolean).every((id) => current.connections.some((connection) => connection.fromNodeId === id && connection.toNodeId === item.nodeId));
                        }));
                    };
                    let updated: CanvasSnapshot | undefined;
                    for (let attempt = 0; attempt < 250; attempt += 1) {
                        const current = snapshotRef.current;
                        if (current.projectId !== before.projectId) throw new Error("批量行生成期间活动画布已切换");
                        if (hasBatchBindings(current)) { updated = current; break; }
                        await new Promise((resolve) => window.setTimeout(resolve, 20));
                    }
                    if (!updated) throw new Error(`批量行批次可能已入队但状态未回读；clientOperationId=${result.clientOperationId}。请查询并用同一 ID 恢复`);
                    await flushCanvasStorePersistence();
                    const persisted = useCanvasStore.getState().projects.find((project) => project.id === before.projectId);
                    if (!persisted || !hasBatchBindings({ ...updated, nodes: persisted.nodes, connections: persisted.connections })) {
                        throw new Error(`批量行批次及输出绑定尚未通过持久化回读；clientOperationId=${result.clientOperationId}。请用同一 ID 恢复`);
                    }
                    snapshotRef.current = updated;
                    await enqueueStateSync(updated);
                    await postResult({ requestId: payload.requestId, result: { ...result, persisted: true, snapshot: updated } });
                    return;
                }
                if (payload.name.startsWith("canvas_batch_table_")) {
                    const operations = batchTableOperationsRef.current as unknown as Record<string, (...args: unknown[]) => unknown>;
                    const suffix = payload.name.slice("canvas_batch_table_".length);
                    const methodBySuffix: Record<string, string> = { read: "read", add_row: "addRow", update_row: "updateRow", remove_row: "removeRow", add_reference_column: "addReferenceColumn", remove_reference_column: "removeReferenceColumn", reorder_reference_columns: "reorderReferenceColumns", move_reference_cell: "moveReferenceCell", sync_rows_from_connections: "syncRowsFromConnections" };
                    const method = methodBySuffix[suffix];
                    const operation = operations[method];
                    if (typeof operation !== "function") throw new Error(`批量表格操作未接入：${method}`);
                    const args = method === "read" || method === "addRow" || method === "addReferenceColumn" || method === "syncRowsFromConnections"
                        ? [input.nodeId]
                        : method === "updateRow" ? [input.nodeId, input.rowId, input.patch]
                        : method === "removeRow" ? [input.nodeId, input.rowId]
                        : method === "removeReferenceColumn" ? [input.nodeId, input.columnId]
                        : method === "reorderReferenceColumns" ? [input.nodeId, input.fromColumnId, input.toColumnId]
                        : method === "moveReferenceCell" ? [input.nodeId, input.sourceRowId, input.sourceColumnIndex, input.targetRowId, input.targetColumnIndex]
                        : [];
                    const result = operation(...args);
                    if (method === "read") {
                        await postResult({ requestId: payload.requestId, result });
                        return;
                    }
                    const readback = result as { nodeId: string; table: unknown; changed: boolean };
                    if (readback.nodeId !== input.nodeId) throw new Error("批量表格操作返回了其他节点");
                    if (readback.changed) {
                        let updated: CanvasSnapshot | undefined;
                        for (let attempt = 0; attempt < 250; attempt += 1) {
                            const current = snapshotRef.current;
                            if (current.projectId !== input.expectedCanvasId) throw new Error("批量表格写入期间活动画布已切换");
                            const table = current.nodes.find((node) => node.id === readback.nodeId)?.metadata?.batchTable;
                            if (JSON.stringify(table) === JSON.stringify(readback.table)) { updated = current; break; }
                            await new Promise((resolve) => window.setTimeout(resolve, 20));
                        }
                        if (!updated) throw new Error(`批量表格状态尚未回读：${readback.nodeId}；先读取表格核对，避免重复执行`);
                        await flushCanvasStorePersistence();
                        const persisted = useCanvasStore.getState().projects.find((project) => project.id === updated!.projectId)?.nodes.find((node) => node.id === readback.nodeId)?.metadata?.batchTable;
                        if (JSON.stringify(persisted) !== JSON.stringify(readback.table)) throw new Error("批量表格写入尚未通过持久化回读");
                        snapshotRef.current = updated;
                        await enqueueStateSync(updated);
                    }
                    await postResult({ requestId: payload.requestId, result: { ...(result as object), persisted: true } });
                    return;
                }
                if (["canvas_duplicate_node", "canvas_toggle_node_locked", "canvas_toggle_frame_collapsed"].includes(payload.name)) {
                    const preconditionConflict = await canvasToolPreconditionConflict({
                        flushPendingStateSync: () => syncQueueRef.current,
                        readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }),
                        expectedRevision: input.expectedRevision,
                        expectedStateHash: input.expectedStateHash,
                    });
                    if (preconditionConflict) throw new Error("画布状态已变化，请重新读取 canvas_get_context 后再执行操作");
                    const before = snapshotRef.current;
                    const nodeId = typeof input.nodeId === "string" ? input.nodeId : "";
                    const source = before.nodes.find((node) => node.id === nodeId);
                    if (!source) throw new Error(`找不到画布节点：${nodeId || "未提供 nodeId"}`);
                    if (payload.name === "canvas_toggle_frame_collapsed" && source.type !== CanvasNodeType.Frame) {
                        throw new Error("只能切换 Frame 节点的折叠状态");
                    }
                    const beforeNodeIds = new Set(before.nodes.map((node) => node.id));
                    const beforeConnectionIds = new Set(before.connections.map((connection) => connection.id));
                    const waitForSnapshot = async (predicate: (value: CanvasSnapshot) => boolean, action: string) => {
                        for (let attempt = 0; attempt < 100; attempt += 1) {
                            const current = snapshotRef.current;
                            if (current.projectId !== before.projectId) throw new Error("操作期间画布已切换，拒绝返回其他画布的结果");
                            if (predicate(current)) return current;
                            await new Promise((resolve) => window.setTimeout(resolve, 20));
                        }
                        throw new Error(`${action}已触发，但页面状态未能在时限内回读确认；请重新读取画布核对`);
                    };

                    if (payload.name === "canvas_duplicate_node") {
                        duplicateNodeRef.current(nodeId, "copy");
                        const copied = await waitForSnapshot((current) => current.nodes.some((node) => !beforeNodeIds.has(node.id) && current.selectedNodeIds.includes(node.id)), "节点复制");
                        const copiedNodeIds = copied.nodes.filter((node) => !beforeNodeIds.has(node.id)).map((node) => node.id);
                        const copiedConnectionIds = copied.connections.filter((connection) => !beforeConnectionIds.has(connection.id)).map((connection) => connection.id);
                        const copyRootId = copied.selectedNodeIds.find((id) => copiedNodeIds.includes(id));
                        if (!copyRootId || !copied.nodes.some((node) => node.id === copyRootId)) throw new Error("原生复制结果缺少可验证的新节点 ID");
                        snapshotRef.current = copied;
                        recordAgentOperationRef.current(before, copied, "复制节点", copiedNodeIds);
                        await postResult({ requestId: payload.requestId, result: { ok: true, sourceNodeId: nodeId, copiedNodeId: copyRootId, copiedNodeIds, copiedConnectionIds, snapshot: copied } });
                        await enqueueStateSync(copied);
                        return;
                    }

                    if (payload.name === "canvas_toggle_node_locked") {
                        const expectedLocked = !Boolean(source.metadata?.locked);
                        toggleNodeLockedRef.current(nodeId);
                        const updated = await waitForSnapshot((current) => {
                            const node = current.nodes.find((item) => item.id === nodeId);
                            return node !== undefined && Boolean(node.metadata?.locked) === expectedLocked;
                        }, "节点锁定切换");
                        snapshotRef.current = updated;
                        recordAgentOperationRef.current(before, updated, expectedLocked ? "锁定节点" : "解锁节点", [nodeId]);
                        await postResult({ requestId: payload.requestId, result: { ok: true, nodeId, locked: expectedLocked, snapshot: updated } });
                        await enqueueStateSync(updated);
                        return;
                    }

                    const expectedCollapsed = !Boolean(source.metadata?.frame?.collapsed);
                    toggleFrameCollapsedRef.current(nodeId);
                    const updated = await waitForSnapshot((current) => {
                        const node = current.nodes.find((item) => item.id === nodeId);
                        return node !== undefined && Boolean(node.metadata?.frame?.collapsed) === expectedCollapsed;
                    }, "Frame 折叠切换");
                    snapshotRef.current = updated;
                    recordAgentOperationRef.current(before, updated, expectedCollapsed ? "折叠 Frame" : "展开 Frame", [nodeId]);
                    await postResult({ requestId: payload.requestId, result: { ok: true, nodeId, collapsed: expectedCollapsed, snapshot: updated } });
                    await enqueueStateSync(updated);
                    return;
                }
                if (payload.name === "canvas_render_timeline") {
                    const before = snapshotRef.current;
                    const beforeHash = hashCanvasSnapshot(before);
                    const expectedHash = String(input.expectedHash);
                    const operationId = String(input.clientOperationId);
                    const existing = before.nodes.find((node) => node.metadata?.timelineRenderOperationId === operationId);
                    if (existing) {
                        if (existing.metadata?.timelineRenderExpectedHash !== expectedHash) throw new Error("此 clientOperationId 已用于不同时间线版本");
                        if (existing.type !== CanvasNodeType.Video) throw new Error("同一 clientOperationId 对应的节点不是视频，请先回读画布");
                        const resourceId = resourceIdFromStorageKey(String(existing.metadata?.storageKey || ""));
                        if (!resourceId) throw new Error("同一 clientOperationId 的成片节点缺少可验证资源，请先回读节点");
                        const durable = useCanvasStore.getState().projects.find((project) => project.id === before.projectId)?.nodes.find((node) => node.id === existing.id);
                        if (!durable || durable.metadata?.timelineRenderOperationId !== operationId || resourceIdFromStorageKey(String(durable.metadata?.storageKey || "")) !== resourceId) {
                            throw new Error("同一 clientOperationId 的成片节点未通过持久化回读");
                        }
                        const report = await probeResource(resourceId, false);
                        if (report.probe.videoStreams < 1 || report.probe.fileSizeBytes < 1) throw new Error("同一 clientOperationId 的成片资源已失效，请先回读核对");
                        await postResult({ requestId: payload.requestId, result: { ok: true, reused: true, videoNodeId: existing.id, resourceId, durationMs: report.probe.durationMs, persisted: true } });
                        return;
                    }
                    if (activeTimelineRenderIdsRef.current.has(operationId)) throw new Error("此 clientOperationId 的时间线渲染仍在进行，请查询画布后再试");
                    activeTimelineRenderIdsRef.current.add(operationId);
                    try {
                        const assertStillCurrent = async () => {
                            const conflict = await canvasToolPreconditionConflict({
                                flushPendingStateSync: () => syncQueueRef.current,
                                readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }),
                                expectedRevision: input.expectedRevision,
                                expectedStateHash: input.expectedStateHash,
                            });
                            if (conflict || snapshotRef.current.projectId !== before.projectId || hashCanvasSnapshot(snapshotRef.current) !== beforeHash) throw new Error("时间线渲染期间画布已变化，请重新读取画布与时间线");
                            const latest = await getTimelineRef.current();
                            if (latest.expectedHash !== expectedHash) throw new Error("时间线版本已变化，请重新读取 canvas_get_timeline");
                        };
                        const timeline = await getTimelineRef.current();
                        if (timeline.projectId !== before.projectId || timeline.expectedHash !== expectedHash) throw new Error("时间线版本或目标画布不匹配，请重新读取 canvas_get_timeline");
                        await assertStillCurrent();
                        let result: { videoNodeId: string; resourceId: string; title: string; durationMs: number; snapshot: CanvasSnapshot } | undefined;
                        await renderCanvasTimeline({ timeline: timeline.timeline, expectedHash, nodes: before.nodes }, {
                            readCurrentExpectedHash: async () => (await getTimelineRef.current()).expectedHash,
                            onRendered: async ({ blob }) => {
                                await assertStillCurrent();
                                const uploaded = await storeGeneratedVideo({ blob });
                                const resourceId = resourceIdFromStorageKey(String(uploaded.storageKey || ""));
                                if (!resourceId) throw new Error("成片上传没有返回本地 Resource ID");
                                const report = await probeResource(resourceId, true);
                                if (!report.probe.decoded || report.probe.videoStreams < 1 || report.probe.fileSizeBytes < 1 || report.probe.durationMs < 100) throw new Error("成片文件未通过完整解码与视频流核验");
                                await assertStillCurrent();
                                const size = fitNodeSize(uploaded.width || report.probe.width || 1280, uploaded.height || report.probe.height || 720, VIDEO_NODE_MAX_SIZE.width, VIDEO_NODE_MAX_SIZE.height);
                                const videoSources = timeline.timeline.clips
                                    .filter((clip) => clip.kind === "video")
                                    .map((clip) => before.nodes.find((node) => node.id === clip.nodeId))
                                    .filter((node): node is CanvasNodeData => Boolean(node && node.type === CanvasNodeType.Video));
                                const sourceNodes = [...new Map(videoSources.map((node) => [node.id, node])).values()];
                                const left = sourceNodes.length ? Math.max(...sourceNodes.map((node) => node.position.x + node.width)) + 120 : 0;
                                const top = sourceNodes.length ? Math.min(...sourceNodes.map((node) => node.position.y)) : 0;
                                const title = typeof input.title === "string" ? input.title : "时间线成片";
                                const rendered = createCanvasNode(CanvasNodeType.Video, { x: left + size.width / 2, y: top + size.height / 2 }, {
                                    ...videoMetadata(uploaded), status: "success", workflowKind: "final", workflowTitle: "时间线成片", videoEditOperation: "timeline_render",
                                    timelineRenderOperationId: operationId, timelineRenderExpectedHash: expectedHash,
                                });
                                rendered.title = title;
                                rendered.width = size.width;
                                rendered.height = size.height;
                                rendered.position = { x: left, y: top };
                                const ops: CanvasOperation[] = [
                                    { type: "add_node", id: rendered.id, nodeType: CanvasNodeType.Video, title, position: rendered.position, width: rendered.width, height: rendered.height, metadata: rendered.metadata },
                                    ...sourceNodes.map((node) => ({ type: "connect_nodes" as const, fromNodeId: node.id, toNodeId: rendered.id })),
                                ];
                                const applied = await applyOpsRef.current(ops, { source: "local", conversationId: "codex-mcp", messageId: payload.requestId });
                                const { generationTasks: _generationTasks, ...next } = applied;
                                const verification = verifyCanvasOperations(before, next, ops);
                                if (!verification.ok) throw new Error(canvasOperationPostconditionMessage(verification));
                                if (!(await persistCanvasRef.current())) throw new Error(`成片节点 ${rendered.id} 已写入页面但保存失败；请按 clientOperationId 回读，避免重复渲染`);
                                const durable = useCanvasStore.getState().projects.find((project) => project.id === before.projectId)?.nodes.find((node) => node.id === rendered.id);
                                if (!durable || durable.metadata?.timelineRenderOperationId !== operationId || resourceIdFromStorageKey(String(durable.metadata?.storageKey || "")) !== resourceId) throw new Error("时间线成片节点未通过持久化回读");
                                snapshotRef.current = next;
                                await enqueueStateSync(next);
                                result = { videoNodeId: rendered.id, resourceId, title, durationMs: report.probe.durationMs, snapshot: next };
                            },
                        });
                        if (!result) throw new Error("时间线渲染结束但未收到画布成片结果");
                        await postResult({ requestId: payload.requestId, result: { ok: true, ...result, persisted: true } });
                    } finally {
                        activeTimelineRenderIdsRef.current.delete(operationId);
                    }
                    return;
                }
                // 最终合片：复用页面“合并成片”同款 FFmpeg 链路与入库逻辑，生成真实视频节点。
                if (payload.name === "canvas_merge_videos") {
                    const requested = Array.isArray(input.videoNodeIds) ? input.videoNodeIds.filter((id): id is string => typeof id === "string") : [];
                    const before = snapshotRef.current;
                    const beforeHash = hashCanvasSnapshot(before);
                    const assertStillCurrent = async () => {
                        const conflict = await canvasToolPreconditionConflict({
                            flushPendingStateSync: () => syncQueueRef.current,
                            readRuntimeRefs: () => ({ revision: runtimeRevisionRef.current, stateHash: runtimeStateHashRef.current }),
                            expectedRevision: input.expectedRevision,
                            expectedStateHash: input.expectedStateHash,
                        });
                        const current = snapshotRef.current;
                        if (conflict || current.projectId !== before.projectId || hashCanvasSnapshot(current) !== beforeHash) {
                            throw new Error("视频合并期间画布已变化；请重新读取画布后再提交合片");
                        }
                    };
                    const videos = requested.map((id) => before.nodes.find((node) => node.id === id));
                    const missing = requested.filter((id, index) => !videos[index]);
                    if (missing.length) throw new Error(`合片必需镜头缺失：${missing.join("、")}。已停止合并，不会用剩余片段代替。`);
                    if (!videos.length) throw new Error("至少需要一个已生成完成的视频节点才能输出成片");
                    for (let index = 0; index < videos.length; index += 1) {
                        const node = videos[index];
                        if (!node || node.type !== CanvasNodeType.Video || !node.metadata?.content) throw new Error(`合片输入第 ${index + 1} 段不是已生成完成的视频`);
                    }
                    const readyVideos = videos as CanvasNodeData[];
                    const blob = await mergeVideos(readyVideos.map((node) => ({ id: node.id, url: node.metadata?.content, storageKey: node.metadata?.storageKey })));
                    await assertStillCurrent();
                    const uploaded = await storeGeneratedVideo({ blob });
                    await assertStillCurrent();
                    const size = fitNodeSize(uploaded.width || 1280, uploaded.height || 720, VIDEO_NODE_MAX_SIZE.width, VIDEO_NODE_MAX_SIZE.height);
                    const left = Math.max(...readyVideos.map((node) => node.position.x + node.width)) + 120;
                    const top = Math.min(...readyVideos.map((node) => node.position.y));
                    const title = String(input.title || `合并成片 · ${readyVideos.length} 段`);
                    const merged = createCanvasNode(CanvasNodeType.Video, { x: left + size.width / 2, y: top + size.height / 2 }, {
                        ...videoMetadata(uploaded),
                        prompt: `按给定顺序合并 ${readyVideos.length} 段视频`,
                        workflowKind: "final",
                        workflowTitle: "合并成片",
                        videoEditOperation: "concat",
                        status: "success",
                    });
                    merged.title = title;
                    merged.width = size.width;
                    merged.height = size.height;
                    merged.position = { x: left, y: top };
                    const ops: CanvasOperation[] = [
                        { type: "add_node", id: merged.id, nodeType: CanvasNodeType.Video, title: merged.title, position: merged.position, width: merged.width, height: merged.height, metadata: merged.metadata },
                        ...readyVideos.map((node) => ({ type: "connect_nodes" as const, fromNodeId: node.id, toNodeId: merged.id })),
                    ];
                    const applied = await applyOpsRef.current(ops, { source: "local", conversationId: "codex-mcp", messageId: payload.requestId });
                    const { generationTasks: _generationTasks, ...next } = applied;
                    const verification = verifyCanvasOperations(before, next, ops);
                    if (!verification.ok) throw new Error(canvasOperationPostconditionMessage(verification));
                    const mergedNode = next.nodes.find((node) => node.id === merged.id);
                    const resourceId = resourceIdFromStorageKey(String(mergedNode?.metadata?.storageKey || ""));
                    if (mergedNode?.type !== CanvasNodeType.Video || !resourceId || mergedNode.metadata?.storageKey !== uploaded.storageKey
                        || readyVideos.some((node) => !next.connections.some((connection) => connection.fromNodeId === node.id && connection.toNodeId === merged.id))) {
                        throw new Error("合片节点、媒体资源或来源连线未通过画布回读");
                    }
                    // applyOps 更新页面 refs；显式走页面的原生保存入口，避免仅 flush
                    // 尚未入队的 React effect，从而把已经成功合片的操作误报为失败。
                    if (!(await persistCanvasRef.current())) {
                        throw new Error(`合片节点 ${merged.id} 已写入页面但保存失败；请读取画布核对，避免重复合并`);
                    }
                    const persisted = useCanvasStore.getState().projects.find((project) => project.id === before.projectId);
                    const durableNode = persisted?.nodes.find((node) => node.id === merged.id);
                    if (durableNode?.metadata?.storageKey !== uploaded.storageKey
                        || readyVideos.some((node) => !persisted?.connections.some((connection) => connection.fromNodeId === node.id && connection.toNodeId === merged.id))) {
                        throw new Error("合片节点或来源连线尚未通过持久化回读；请读取画布核对，避免重复合并");
                    }
                    snapshotRef.current = next;
                    await enqueueStateSync(next);
                    await postResult({ requestId: payload.requestId, result: { ok: true, videoNodeId: merged.id, resourceId, title, mergedCount: readyVideos.length, persisted: true, snapshot: next } });
                    return;
                }
                if (isAgentRuntimeToolName(payload.name)) {
                    const result = await runAgentRuntimeTool(payload.name, input);
                    await postResult({ requestId: payload.requestId, result });
                    return;
                }
                if (isProjectAgentToolName(payload.name)) {
                    const input2 = payload.name === "project_create_from_script"
                        ? { ...input, ...(!input.createNewCanvas && snapshotRef.current.projectId ? { canvasId: input.canvasId || snapshotRef.current.projectId } : {}) }
                        : input;
                    const result = await runProjectAgentTool(payload.name, input2, snapshotRef.current.domainProjectId);
                    if (payload.name === "project_create_from_script" && result && typeof result === "object") {
                        const bootstrap = result as { projectId?: unknown; canvas?: { id?: unknown } };
                        const current = snapshotRef.current;
                        if (typeof bootstrap.projectId === "string" && bootstrap.canvas?.id === current.projectId && current.domainProjectId !== bootstrap.projectId) {
                            const next = { ...current, domainProjectId: bootstrap.projectId };
                            snapshotRef.current = next;
                            await enqueueStateSync(next);
                        }
                    }
                    await postResult({ requestId: payload.requestId, result });
                    return;
                }
                // 影视流水线工具：调用页面同款的生成任务与提示词模板能力，不重新实现业务逻辑。
                if (isFilmAgentToolName(payload.name)) {
                    const input2 = { ...input };
                    if (!input2.projectId && snapshotRef.current.domainProjectId) input2.projectId = snapshotRef.current.domainProjectId;
                    let result: unknown = await runFilmAgentTool(payload.name, input2, { canvasNodes: snapshotRef.current.nodes });
                    if (payload.name === "film_submit_step") {
                        const submission = result as { idempotent?: boolean; task?: { id?: string; type?: string; status?: string; productionRunId?: string; inputJson?: string }; [key: string]: unknown };
                        const task = submission.task;
                        const taskInput = task?.inputJson ? JSON.parse(task.inputJson) as { metadata?: { canvasId?: string; nodeId?: string } } : undefined;
                        const targetId = taskInput?.metadata?.nodeId;
                        const targetNode = snapshotRef.current.nodes.find((node) => node.id === targetId);
                        if (task?.id && targetId && task.productionRunId === input2.runId
                            && taskInput?.metadata?.canvasId === snapshotRef.current.projectId
                            && targetNode && `canvas_${targetNode.type}` === task.type) {
                            if (!canBindProductionTaskSubmission(targetNode, task.id, submission.idempotent)) {
                                result = { ...submission, canvasBinding: { nodeId: targetId, taskId: task.id, persisted: false,
                                    status: "superseded", activeTaskId: targetNode.metadata?.taskId } };
                            } else {
                            const next = await applyOpsRef.current([{ type: "update_node", id: targetId,
                                metadata: { ...submittedVideoSettingsMetadata(task.inputJson), taskId: task.id, productionRunId: task.productionRunId,
                                    ...(targetNode.metadata?.taskId !== task.id
                                        || !targetNode.metadata?.generationEffectKeys?.some((key) => key.startsWith(`attach-node:${task.id}:`))
                                        ? { status: "loading", taskStatus: task.status || "queued", taskProgress: 0, errorDetails: undefined }
                                        : {}) } }],
                                { source: "local", conversationId: "codex-mcp", messageId: payload.requestId });
                            await flushCanvasStorePersistence();
                            snapshotRef.current = next;
                            await enqueueStateSync(next);
                            result = { ...submission, canvasBinding: { nodeId: targetId, taskId: task.id, persisted: true } };
                            }
                        }
                    }
                    if (payload.name === "film_verify_delivery" && input2.runId) {
                        const verification = result as { deliveryStatus?: unknown; run?: ProductionRun };
                        const status = verification.deliveryStatus;
                        const run = verification.run;
                        if (run && (status === "passed" || status === "failed" || status === "uncertain")) {
                            const current = snapshotRef.current;
                            const resourceId = run.finalResourceId || String(input2.resourceId || "");
                            const matches = current.nodes.filter((node) => {
                                const metadata = node.metadata as (typeof node.metadata & Record<string, unknown>) | undefined;
                                return node.type === CanvasNodeType.Video
                                    && metadata?.workflowKind === "final"
                                    && (resourceIdFromStorageKey(metadata.storageKey) === resourceId || metadata.resourceId === resourceId);
                            });
                            let canvasBinding: Record<string, unknown>;
                            if (run.canvasId && run.canvasId !== current.projectId) {
                                canvasBinding = { status: "canvas_mismatch", reason: "ProductionRun 绑定的画布与当前画布不同" };
                            } else if (matches.length !== 1) {
                                canvasBinding = { status: matches.length ? "ambiguous" : "not_found", matchingNodeCount: matches.length };
                            } else {
                                const node = matches[0];
                                try {
                                    const next = await applyOpsRef.current([{
                                        type: "update_node",
                                        id: node.id,
                                        metadata: { productionRunId: run.id, productionDeliveryStatus: status },
                                    }], { source: "local", conversationId: "codex-mcp", messageId: payload.requestId });
                                    const persisted = next.nodes.find((item) => item.id === node.id)?.metadata;
                                    if (persisted?.productionRunId !== run.id || persisted.productionDeliveryStatus !== status) {
                                        throw new Error("画布未回读到交付验收状态");
                                    }
                                    snapshotRef.current = next;
                                    await enqueueStateSync(next);
                                    canvasBinding = { status: "updated", nodeId: node.id, resourceId, productionRunId: run.id };
                                } catch (error) {
                                    canvasBinding = { status: "failed", reason: error instanceof Error ? error.message : "无法写回画布验收状态" };
                                }
                            }
                            result = { ...(verification as Record<string, unknown>), canvasBinding };
                        }
                    }
                    await postResult({ requestId: payload.requestId, result });
                    return;
                }
                throw new Error(`本地 Agent 不支持的工具：${payload.name}`);
            } catch (error) {
                const message = error instanceof Error ? error.message : "画布操作失败";
                await postResult({ requestId: payload.requestId, error: message }).catch(() => undefined);
            }
        };

        const consumeStream = async (lastEventId: { value: string }) => {
            const response = await getLocalRuntimeSessionClient().request(`/events?clientId=${encodeURIComponent(clientIdRef.current)}`, {
                method: "GET",
                headers: lastEventId.value ? { "Last-Event-ID": lastEventId.value } : undefined,
                signal: controller.signal,
            });
            if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
                throw new Error("本地 Canvas Agent 事件流不可用");
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8", { fatal: true });
            let buffer = "";
            let eventType = "";
            let eventId: string | undefined;
            let data: string[] = [];
            const dispatch = () => {
                if (!data.length) return;
                const type = eventType || "message";
                if (eventId) lastEventId.value = eventId;
                if (type === "hello") {
                    connectedRef.current = true;
                    setConnection("connected");
                    void enqueueStateSync(snapshotRef.current);
                } else if (type === "tool_call") {
                    try {
                        const payload = JSON.parse(data.join("\n")) as ToolCallPayload;
                        void runToolCall(payload);
                    } catch {
                        // Malformed optional events must not terminate the stream.
                    }
                }
                eventType = "";
                eventId = undefined;
                data = [];
            };
            const consumeLine = (line: string) => {
                if (!line) {
                    dispatch();
                    return;
                }
                if (line.startsWith(":")) return;
                const separator = line.indexOf(":");
                const field = separator < 0 ? line : line.slice(0, separator);
                const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
                if (field === "event") eventType = value;
                else if (field === "data") data.push(value);
                else if (field === "id" && !value.includes("\0")) eventId = value;
            };
            try {
                while (!controller.signal.aborted) {
                    const item = await reader.read();
                    if (item.done) break;
                    buffer += decoder.decode(item.value, { stream: true });
                    let newline = buffer.indexOf("\n");
                    while (newline >= 0) {
                        consumeLine(buffer.slice(0, newline).replace(/\r$/, ""));
                        buffer = buffer.slice(newline + 1);
                        newline = buffer.indexOf("\n");
                    }
                }
                buffer += decoder.decode();
                if (buffer) consumeLine(buffer.replace(/\r$/, ""));
                dispatch();
            } finally {
                await reader.cancel().catch(() => undefined);
                reader.releaseLock();
            }
        };

        const connectLoop = async () => {
            const lastEventId = { value: "" };
            while (!controller.signal.aborted) {
                try {
                    setConnection((current) => (current === "connected" ? current : "connecting"));
                    const runtime = useLocalRuntimeStore.getState();
                    // A 401 from the event stream clears the session client-side, but
                    // the Zustand status can still say "connected". Re-run the
                    // handshake on every reconnect so that stale status cannot strand
                    // the canvas bridge without an authenticated session.
                    await runtime.connect(controller.signal);
                    if (useLocalRuntimeStore.getState().connection !== "connected") {
                        throw new Error(useLocalRuntimeStore.getState().error || "本机 Canvas Agent 未连接");
                    }
                    await consumeStream(lastEventId);
                    if (!controller.signal.aborted) throw new Error("Canvas Agent 事件流已断开");
                } catch (error) {
            if (controller.signal.aborted) return;
            const hadConnection = connectedRef.current;
            connectedRef.current = false;
            setConnection("error");
            retryDelay = Math.min(retryDelay * 1.6, 8000);
            const message = error instanceof Error ? error.message : "本机 Canvas Agent 不可用";
            // 页面刚打开时本机会话还没建立，第一次握手失败属正常竞态，自动重试即可；
            // 只有“已经连上过再掉线”才算真正需要提醒的问题。
            if (hadConnection) console.warn(`[yingce-local-agent] ${message}`);
            else console.debug(`[yingce-local-agent] 连接重试：${message}`);
                    await new Promise<void>((resolve) => {
                        const timer = setTimeout(resolve, retryDelay);
                        controller.signal.addEventListener("abort", () => {
                            clearTimeout(timer);
                            resolve();
                        }, { once: true });
                    });
                }
            }
        };

        void connectLoop();
        return () => {
            controller.abort();
            connectedRef.current = false;
            syncSnapshotRef.current = () => undefined;
            if (syncTimerRef.current) {
                clearTimeout(syncTimerRef.current);
                syncTimerRef.current = undefined;
            }
            setConnection("idle");
        };
    }, [open, snapshot.projectId]);

    if (!open) return null;
    const connected = connection === "connected";
    return (
        <aside className="pointer-events-auto fixed bottom-4 right-4 z-[var(--z-modal-overlay)] w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-xl border bg-background shadow-2xl" aria-label="本地 Canvas Agent">
            <header className="flex items-center gap-2 border-b px-3 py-2.5">
                <span className="grid size-7 place-items-center rounded-md bg-foreground/5 text-foreground"><Bot className="size-4" /></span>
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">本地 Canvas Agent</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-foreground/55">
                        <span className={`size-1.5 rounded-full ${connected ? "bg-emerald-500" : connection === "connecting" ? "bg-amber-500" : "bg-red-500"}`} />
                        {connected ? "已连接，等待 Codex MCP 调用" : connection === "connecting" ? "正在连接本机运行时" : "未连接，请运行一键启动"}
                    </div>
                </div>
                <button type="button" className="rounded-md p-1.5 text-foreground/55 hover:bg-foreground/5" onClick={onClose} aria-label="关闭">
                    <X className="size-4" />
                </button>
            </header>
            <div className="space-y-2 px-3 py-3 text-xs leading-5 text-foreground/65">
                <div>运行时：<span className="font-mono text-foreground">http://127.0.0.1:17371</span></div>
                <div>画布：<span className="font-mono text-foreground">{snapshot.projectId}</span></div>
                {snapshot.domainProjectId ? <div>短剧项目：<span className="font-mono text-foreground">{snapshot.domainProjectId}</span></div> : null}
                <div>在 Codex 中使用 <span className="font-mono text-foreground">yingce</span> MCP 即可读取和修改当前画布。</div>
                {productionRun ? (
                    <div className="mt-3 border-t pt-3">
                        <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-foreground">整片制作</span>
                            <span className="font-mono text-[10px] text-foreground/55">{productionRun.status} · r{productionRun.revision}</span>
                        </div>
                        <div className="mt-1 truncate text-[11px] text-foreground/55">{productionRun.currentStage || "planning"}</div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {productionRun.status === "planning" ? (
                                <button type="button" disabled={productionBusy} onClick={() => void runProductionAction("authorize")} className="rounded-md bg-foreground px-2 py-1 text-[11px] text-background disabled:opacity-40">授权当前制作</button>
                            ) : null}
                            {productionRun.status === "paused" ? (
                                <button type="button" disabled={productionBusy} onClick={() => void runProductionAction("resume")} className="rounded-md border px-2 py-1 text-[11px] disabled:opacity-40">恢复</button>
                            ) : productionRun.status !== "cancelled" ? (
                                <button type="button" disabled={productionBusy} onClick={() => void runProductionAction("pause")} className="rounded-md border px-2 py-1 text-[11px] disabled:opacity-40">暂停</button>
                            ) : null}
                            {productionRun.status !== "cancelled" ? (
                                <button type="button" disabled={productionBusy} onClick={() => void runProductionAction("cancel")} className="rounded-md border px-2 py-1 text-[11px] text-red-600 disabled:opacity-40">取消</button>
                            ) : null}
                        </div>
                    </div>
                ) : null}
            </div>
        </aside>
    );
}
