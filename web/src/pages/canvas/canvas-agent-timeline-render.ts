import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineProject } from "@/types/timeline";
import { exportTimelineToMp4 } from "@/lib/timeline/timeline-export";
import type { TimelineRenderSource } from "@/lib/timeline/timeline-to-ffmpeg";
import { getOrderedOverlayClips, getOrderedVideoClips } from "@/lib/timeline/timeline-to-ffmpeg";
import { timelineOverlayRect } from "@/lib/timeline/timeline-overlay";

/** Payload from canvas_get_timeline plus the canvas node snapshot used to resolve media. */
export type CanvasTimelineRenderSnapshot = {
    timeline: TimelineProject;
    expectedHash: string;
    nodes: CanvasNodeData[];
};

export type CanvasTimelineRenderOptions = {
    readCurrentExpectedHash: () => Promise<string>;
    /** Upload the finished MP4 and write the resulting media onto the canvas video node. */
    onRendered: (result: { blob: Blob; fileName: string; expectedHash: string }) => Promise<void>;
    render?: typeof exportTimelineToMp4;
};

export const CANVAS_TIMELINE_RENDER_LIMITATIONS = [
    "The native renderer does not support this active timeline content.",
    "字幕 overlay 烧录失败，已取消导出",
] as const;

function mediaUrl(node: CanvasNodeData): string | undefined {
    const metadata = node.metadata;
    const value = metadata?.content;
    if (value?.trim()) return value;
    return undefined;
}

function sourceForClip(node: CanvasNodeData, sourceStartMs: number, durationMs: number, index: number, clipId: string): TimelineRenderSource {
    const metadata = node.metadata;
    const url = mediaUrl(node);
    const storageKey = metadata?.storageKey;
    if (!url && !storageKey) throw new Error(`视频片段 ${node.id} 没有可读取的素材源`);
    const mimeType = metadata?.mimeType;
    if (mimeType && !mimeType.toLowerCase().startsWith("video/")) throw new Error(`节点 ${node.id} 的素材不是视频`);
    const measuredDuration = metadata?.durationMs;
    if (!Number.isFinite(measuredDuration) || !measuredDuration || measuredDuration <= 0) {
        throw new Error(`节点 ${node.id} 缺少有效的视频素材时长`);
    }
    if (sourceStartMs < 0 || sourceStartMs + durationMs > measuredDuration + 50) throw new Error(`视频片段 ${node.id} 时长超过素材时长`);
    return {
        nodeId: node.id,
        clipId,
        fileName: `canvas-video-${index}.mp4`,
        durationMs: measuredDuration,
        ...(storageKey ? { storageKey } : {}),
        ...(url ? { url } : {}),
    };
}

export function buildCanvasTimelineRenderSources(snapshot: CanvasTimelineRenderSnapshot): TimelineRenderSource[] {
    const { timeline, nodes } = snapshot;
    const visibleTrackIds = new Set(timeline.tracks.filter((track) => track.visible !== false).map((track) => track.id));
    const trackById = new Map(timeline.tracks.map((track) => [track.id, track]));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const videoClips = getOrderedVideoClips(timeline);
    const overlays = getOrderedOverlayClips(timeline).filter((clip) => clip.kind === "image");
    const textClips = getOrderedOverlayClips(timeline).filter((clip) => clip.kind === "text");
    const clips = videoClips.concat(timeline.clips.filter((clip) => clip.kind === "audio" && trackById.get(clip.trackId)?.visible !== false && !trackById.get(clip.trackId)?.muted).sort((a, b) => a.startMs - b.startMs), overlays, textClips);
    for (const clip of [...overlays, ...textClips]) timelineOverlayRect(clip);
    if (clips.some((clip) => !visibleTrackIds.has(clip.trackId))) throw new Error("原生渲染器不支持隐藏视频轨，已拒绝渲染以避免丢失片段");
    if (videoClips.length === 0) throw new Error("时间线没有可渲染的视频片段");
    return clips.map((clip, index) => {
        if (!Number.isFinite(clip.durationMs) || clip.durationMs <= 0 || !Number.isFinite(clip.startMs) || clip.startMs < 0) {
            throw new Error(`视频片段 ${clip.id} 的时间范围无效`);
        }
        const direct = clip.directMedia;
        const expectedKind = clip.kind;
        if (direct) {
            if (clip.kind === "text") {
                const text = clip.text ?? direct.content ?? direct.dataUrl ?? "";
                if (!text.trim()) throw new Error(`文字片段 ${clip.id} 缺少文本内容`);
                return { nodeId: clip.nodeId, clipId: clip.id, fileName: `canvas-text-${index}.txt`, durationMs: clip.durationMs, text };
            }
            if (direct.kind !== expectedKind) throw new Error(`片段 ${clip.id} 绑定的直连素材类型不匹配`);
            const durationMs = direct.durationMs || clip.durationMs;
            if ((clip.kind === "video" || clip.kind === "audio") && (!direct.durationMs || direct.durationMs <= 0 || (clip.sourceStartMs || 0) + clip.durationMs > direct.durationMs + 50)) throw new Error(`片段 ${clip.id} 缺少有效素材时长或片段时长超限`);
            const url = direct.dataUrl || direct.content || direct.url;
            if (!url && !direct.storageKey) throw new Error(`片段 ${clip.id} 没有可读取的素材源`);
            if (direct.mimeType && !direct.mimeType.toLowerCase().startsWith(expectedKind + "/")) throw new Error(`片段 ${clip.id} 的直连素材类型不匹配`);
            if (clip.kind === "image" && direct.mimeType && !["image/png", "image/jpeg", "image/webp"].includes(direct.mimeType.toLowerCase())) throw new Error(`图片片段 ${clip.id} 暂不支持 ${direct.mimeType} 格式（支持 PNG、JPEG、WebP）`);
            return { nodeId: clip.nodeId, clipId: clip.id, fileName: `canvas-${expectedKind}-${index}.${expectedKind === "audio" ? "audio" : expectedKind === "image" ? "image" : "mp4"}`, durationMs, ...(direct.storageKey ? { storageKey: direct.storageKey } : {}), ...(url ? { url } : {}), ...(direct.mimeType ? { mimeType: direct.mimeType } : {}) };
        }
        const node = nodeById.get(clip.nodeId);
        if (clip.kind === "text") {
            const text = clip.text ?? node?.metadata?.content ?? "";
            if (!text.trim()) throw new Error(`文字片段 ${clip.id} 缺少文本内容`);
            return { nodeId: clip.nodeId, clipId: clip.id, fileName: `canvas-text-${index}.txt`, durationMs: clip.durationMs, text };
        }
        if (!node || node.type !== expectedKind) throw new Error(`${expectedKind === "audio" ? "音频" : expectedKind === "image" ? "图片" : "视频"}片段 ${clip.id} 缺少有效的素材节点`);
        if (expectedKind === "audio") {
            const url = mediaUrl(node), storageKey = node.metadata?.storageKey, durationMs = node.metadata?.durationMs;
            if (!url && !storageKey) throw new Error(`音频片段 ${clip.id} 没有可读取的素材源`);
            if (!Number.isFinite(durationMs) || !durationMs || durationMs <= 0 || (clip.sourceStartMs || 0) + clip.durationMs > durationMs + 50) throw new Error(`音频片段 ${clip.id} 缺少有效素材时长或片段时长超限`);
            const mime = node.metadata?.mimeType;
            if (mime && !mime.toLowerCase().startsWith("audio/")) throw new Error(`节点 ${node.id} 的素材不是音频`);
            return { nodeId: clip.nodeId, clipId: clip.id, fileName: `canvas-audio-${index}.audio`, durationMs, ...(storageKey ? { storageKey } : {}), ...(url ? { url } : {}) };
        }
        if (expectedKind === "image") {
            const url = mediaUrl(node), storageKey = node.metadata?.storageKey;
            if (!url && !storageKey) throw new Error(`图片片段 ${clip.id} 没有可读取的素材源`);
            const mime = node.metadata?.mimeType;
            if (mime && !["image/png", "image/jpeg", "image/webp"].includes(mime.toLowerCase())) throw new Error(`图片片段 ${clip.id} 暂不支持 ${mime} 格式`);
            return { nodeId: clip.nodeId, clipId: clip.id, fileName: `canvas-image-${index}.image`, durationMs: clip.durationMs, ...(storageKey ? { storageKey } : {}), ...(url ? { url } : {}), ...(mime ? { mimeType: mime } : {}) };
        }
        return sourceForClip(node, clip.sourceStartMs || 0, clip.durationMs, index, clip.id);
    });
}

/** Render the persisted snapshot, guard against concurrent timeline edits, then hand the MP4 to the canvas writer. */
export async function renderCanvasTimeline(snapshot: CanvasTimelineRenderSnapshot, options: CanvasTimelineRenderOptions): Promise<void> {
    if (!snapshot.expectedHash) throw new Error("canvas_get_timeline 未返回 expectedHash");
    const sources = buildCanvasTimelineRenderSources(snapshot);
    const blob = await (options.render || exportTimelineToMp4)(snapshot.timeline, sources);
    if (!(blob instanceof Blob) || blob.size === 0 || blob.type !== "video/mp4") throw new Error("时间线渲染未生成有效的 MP4 文件");
    const currentHash = await options.readCurrentExpectedHash();
    if (currentHash !== snapshot.expectedHash) throw new Error("时间线在渲染期间已更改，已取消写回；请重新读取时间线后再试");
    await options.onRendered({ blob, fileName: "canvas-timeline.mp4", expectedHash: snapshot.expectedHash });
}
