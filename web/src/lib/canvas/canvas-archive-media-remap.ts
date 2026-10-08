import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasDrawingEngine } from "@/lib/canvas/canvas-drawing-engine";

export type CanvasArchiveMediaMapping = { storageKey: string; url: string };

function remapEmbeddedMediaReferences<T>(value: T, mappings: Map<string, CanvasArchiveMediaMapping>): T {
    if (Array.isArray(value)) return value.map((item) => remapEmbeddedMediaReferences(item, mappings)) as T;
    if (!value || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    const mapped = typeof source.storageKey === "string" ? mappings.get(source.storageKey) : undefined;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) next[key] = remapEmbeddedMediaReferences(child, mappings);
    if (mapped) {
        next.storageKey = mapped.storageKey;
        delete next.assetId;
        for (const key of ["url", "dataUrl", "previewContent"]) {
            if (typeof source[key] === "string" && source[key]) next[key] = mapped.url;
        }
        const kind = typeof source.kind === "string" ? source.kind : typeof source.type === "string" ? source.type : "";
        if (["image", "video", "audio"].includes(kind) && typeof source.content === "string" && /^(blob:|data:(image|video|audio)\/|https?:\/\/|\/api\/resources\/)/i.test(source.content)) next.content = mapped.url;
    }
    return next as T;
}

function remapNodeMedia(node: CanvasNodeData, mappings: Map<string, CanvasArchiveMediaMapping>, drawingEngineById: Map<string, CanvasDrawingEngine>): CanvasNodeData {
    const oldKey = node.metadata?.storageKey;
    const mapped = oldKey ? mappings.get(oldKey) : undefined;
    const isDeadBlob = (val?: string) => typeof val === "string" && val.startsWith("blob:");
    const isMediaNode = node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio;
    const nextStorageKey = mapped ? mapped.storageKey : oldKey && !isDeadBlob(oldKey) ? oldKey : undefined;
    const content = isMediaNode && mapped ? mapped.url : isMediaNode && isDeadBlob(node.metadata?.content) ? "" : node.metadata?.content;
    const previewContent = isMediaNode && mapped ? mapped.url : isMediaNode && isDeadBlob(node.metadata?.previewContent) ? "" : node.metadata?.previewContent;
    return {
        ...node,
        metadata: {
            ...node.metadata,
            ...(nextStorageKey !== undefined ? { storageKey: nextStorageKey } : {}),
            ...(content !== undefined ? { content } : {}),
            ...(previewContent !== undefined ? { previewContent } : {}),
            drawingEngine: node.type === CanvasNodeType.Drawing && node.metadata?.drawingId ? drawingEngineById.get(node.metadata.drawingId) || node.metadata.drawingEngine || "tldraw" : node.metadata?.drawingEngine,
        },
    };
}

/** Preserve text-file bodies while remapping every packaged media reference to its imported copy. */
export function remapArchiveProjectMedia(project: CanvasProject, mappings: Map<string, CanvasArchiveMediaMapping>, drawingEngineById: Map<string, CanvasDrawingEngine>): CanvasProject {
    const nodes = project.nodes.map((node) => remapNodeMedia(node, mappings, drawingEngineById));
    return remapEmbeddedMediaReferences({ ...project, nodes }, mappings);
}
