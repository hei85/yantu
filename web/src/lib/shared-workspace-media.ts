import { getImageBlob } from "@/services/image-storage";
import { getMediaBlob } from "@/services/file-storage";
import { resourceFileUrl, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { primeResourceBlobCache } from "@/services/resource-blob-cache";

type Mapping = { storageKey: string; url: string };
const promoted = new Map<string, Promise<Mapping | null>>();
const blobMappings = new Map<string, string>();
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const storageKeyField = (key: string) => key === "storageKey" || key.endsWith("StorageKey");
const mediaURL = (value: unknown): value is string => typeof value === "string" && /^(blob:|data:(?:image|video|audio)\/|https?:\/\/|\/api\/)/i.test(value);

async function promote(key: string): Promise<Mapping | null> {
    if (key.startsWith("resource:")) return { storageKey: key, url: resourceFileUrl(key.slice(9)) };
    let promise = promoted.get(key);
    if (!promise) {
        promise = (async () => {
            const blob = await getImageBlob(key) || await getMediaBlob(key);
            if (!blob) return null;
            const kind = blob.type.startsWith("video/") ? "video" : blob.type.startsWith("audio/") ? "audio" : blob.type.startsWith("image/") ? "image" : "file";
            const resource = await uploadResourceFile(blob, kind, { idempotencyKey: key });
            const storageKey = resourceStorageKey(resource.id);
            await primeResourceBlobCache(storageKey, blob).catch(() => undefined);
            return { storageKey, url: resourceFileUrl(resource.id) };
        })();
        promoted.set(key, promise);
        void promise.catch(() => { if (promoted.get(key) === promise) promoted.delete(key); });
    }
    return promise;
}

export async function prepareSharedWorkspaceMedia(name: string, value: string, scope: string) {
    const document: unknown = JSON.parse(value);
    const keys = new Set<string>();
    const objects: Record<string, unknown>[] = [];
    const collect = (item: unknown) => {
        if (Array.isArray(item)) { item.forEach(collect); return; }
        if (!isRecord(item)) return;
        objects.push(item);
        for (const [key, child] of Object.entries(item)) {
            if (storageKeyField(key) && typeof child === "string" && child.includes(":")) keys.add(child);
            collect(child);
        }
    };
    collect(document);
    const mappings = new Map<string, Mapping>();
    // Small batches avoid exhausting browser memory while promoting old videos.
    const list = [...keys];
    for (let offset = 0; offset < list.length; offset += 3) {
        await Promise.all(list.slice(offset, offset + 3).map(async (key) => {
            const mapping = await promote(key);
            if (mapping) mappings.set(key, mapping);
        }));
    }
    for (const object of objects) {
        for (const [key, oldKey] of Object.entries(object)) {
            if (!storageKeyField(key) || typeof oldKey !== "string") continue;
            const mapping = mappings.get(oldKey);
            const prefix = key === "storageKey" ? "" : key.slice(0, -"StorageKey".length);
            const fields = prefix ? [`${prefix}Url`, `${prefix}Content`] : ["url", "dataUrl", "content"];
            if (mapping) {
                object[key] = mapping.storageKey;
                for (const field of fields) {
                    if (!mediaURL(object[field])) continue;
                    if ((object[field] as string).startsWith("blob:")) blobMappings.set(object[field] as string, mapping.url);
                    object[field] = mapping.url;
                }
                // Image previews share the image; video poster images remain distinct.
                if (prefix === "" && typeof object.previewContent === "string" && object.previewContent.startsWith("blob:") && blobMappings.has(object.previewContent)) object.previewContent = blobMappings.get(object.previewContent);
                if (object.pendingResourceUpload === true) { delete object.pendingResourceUpload; delete object.resourceUploadError; }
            } else if (fields.some((field) => typeof object[field] === "string" && (object[field] as string).startsWith("blob:"))) {
                throw new Error(`旧媒体仍只存在于原浏览器，暂时无法迁移：${oldKey}。原记录已保留。`);
            }
        }
    }
    const replaceBlobURLs = async (item: unknown): Promise<void> => {
        if (Array.isArray(item)) { for (const child of item) await replaceBlobURLs(child); return; }
        if (!isRecord(item)) return;
        for (const [key, child] of Object.entries(item)) {
            if (typeof child === "string" && child.startsWith("blob:") && /(?:url|content|cover|poster|src)$/i.test(key)) {
                let replacement = blobMappings.get(child);
                if (!replacement) {
                    const response = await fetch(child);
                    if (!response.ok) throw new Error("无法读取旧浏览器媒体，原数据已保留，迁移尚未完成");
                    const blob = await response.blob();
                    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
                    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
                    const kind = blob.type.startsWith("video/") ? "video" : blob.type.startsWith("audio/") ? "audio" : blob.type.startsWith("image/") ? "image" : "file";
                    const resource = await uploadResourceFile(blob, kind, { idempotencyKey: `workspace:${scope}:${hash}` });
                    replacement = resourceFileUrl(resource.id);
                    blobMappings.set(child, replacement);
                }
                item[key] = replacement;
            } else await replaceBlobURLs(child);
        }
    };
    await replaceBlobURLs(document);
    if (name === "infinite-canvas:canvas_store" && isRecord(document) && isRecord(document.state) && Array.isArray(document.state.projects)) {
        const { migrateLegacyCanvasDrawings } = await import("@/lib/canvas/canvas-drawing-storage");
        for (const project of document.state.projects) {
            if (!isRecord(project) || typeof project.id !== "string" || !Array.isArray(project.nodes)) continue;
            await migrateLegacyCanvasDrawings(project.id, project.nodes, scope);
        }
    }
    return JSON.stringify(document);
}
