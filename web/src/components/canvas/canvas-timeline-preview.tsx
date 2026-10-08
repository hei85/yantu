import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { resolveMediaUrl } from "@/services/file-storage";
import { cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { formatTimelineTime } from "@/lib/timeline/timeline-view";
import { createDefaultSubtitleStyle } from "@/types/timeline";
import type { TimelineClip, TimelineTrack } from "@/types/timeline";
import type { CanvasNodeData } from "@/types/canvas";
import { CanvasSubtitleOverlay } from "./canvas-subtitle-overlay";
import { drawTimelineOverlay } from "@/lib/timeline/timeline-overlay";

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

type CanvasTimelinePreviewProps = {
    clips: TimelineClip[];
    tracks?: TimelineTrack[];
    nodes: CanvasNodeData[];
    playheadMs: number;
    playing: boolean;
    theme: CanvasTheme;
    onTogglePlay: () => void;
    onPlayheadChange: (ms: number) => void;
};

const PREVIEW_WIDTH = 300;
const PREVIEW_HEIGHT = 168;
const AUTO_ADVANCE_GAP_MS = 500;

/**
 * 时间线弹窗的所见即所得预览：显示播放头所在视频片段，并叠加当前字幕。
 * 播放时以视频时间为基准推进播放头；暂停时播放头（标尺跳转）驱动视频画面。
 */
export function CanvasTimelinePreview({ clips, tracks, nodes, playheadMs, playing, theme, onTogglePlay, onPlayheadChange }: CanvasTimelinePreviewProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
    const overlayImagesRef = useRef(new Map<string, HTMLImageElement>());
    const [videoUrl, setVideoUrl] = useState("");
    const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
    const [overlayError, setOverlayError] = useState("");
    // 源内定位目标（秒）；视频换源后 metadata 尚未加载时先记录，loadedmetadata 后再应用。
    const targetSeekSecRef = useRef<number | null>(null);

    const visibleClip = (clip: TimelineClip) => tracks?.find((track) => track.id === clip.trackId)?.visible !== false;
    const videoClips = useMemo(() => clips.filter((clip) => clip.kind === "video" && visibleClip(clip)).sort((a, b) => a.startMs - b.startMs), [clips, tracks]);
    const activeVideoClip = useMemo(() => videoClips.find((clip) => playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs) || null, [playheadMs, videoClips]);
    const activeSubtitleClip = useMemo(() => clips.find((clip) => clip.kind === "subtitle" && visibleClip(clip) && playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs && Boolean(clip.text?.trim())) || null, [clips, playheadMs, tracks]);
    const activeVisualOverlays = useMemo(() => clips.filter((clip) => (clip.kind === "text" || clip.kind === "image") && visibleClip(clip) && playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs).sort((a, b) => (tracks?.find((track) => track.id === a.trackId)?.order ?? 0) - (tracks?.find((track) => track.id === b.trackId)?.order ?? 0) || a.startMs - b.startMs || a.id.localeCompare(b.id)), [clips, playheadMs, tracks]);
    const activeNode = useMemo(() => (activeVideoClip ? nodes.find((node) => node.id === activeVideoClip.nodeId) || null : null), [activeVideoClip, nodes]);
    const subtitleStyle = activeNode?.metadata?.subtitleStyle || createDefaultSubtitleStyle();
    const activeHighlight = useMemo(() => {
        if (!activeSubtitleClip || activeSubtitleClip.subtitleEntryIndex === undefined || activeSubtitleClip.subtitleEntryIndex < 0 || !activeNode) return undefined;
        // subtitleEntryIndex 与字幕条目 index 同为 1 基，直接匹配，不再 +1（此前高亮永远匹配不上）。
        return (activeNode.metadata?.subtitleHighlights || []).find((item) => item.entryIndex === activeSubtitleClip.subtitleEntryIndex);
    }, [activeNode, activeSubtitleClip]);

    // 解析当前片段视频地址（与字幕弹窗同一套缓存/回退策略）。
    useEffect(() => {
        const node = activeNode;
        const media = activeVideoClip?.directMedia;
        setVideoUrl("");
        setVideoSize(null);
        if (!node && !media) return;
        let cancelled = false;
        // 直连媒体片段（directMedia，不落画布）与画布节点走同一套缓存/回退解析策略
        const storageKey = node?.metadata?.storageKey || media?.storageKey || "";
        const fallback = node?.metadata?.content || media?.url || "";
        const applyUrl = (url: string) => {
            if (!cancelled) setVideoUrl(url);
        };
        if (resourceIdFromStorageKey(storageKey)) {
            void cacheResourceObjectUrl(storageKey)
                .then((cached) => {
                    if (cancelled) return;
                    if (cached) {
                        setVideoUrl(cached);
                    } else {
                        void resolveMediaUrl(storageKey, fallback).then(applyUrl);
                    }
                })
                .catch(() => {
                    if (!cancelled) void resolveMediaUrl(storageKey, fallback).then(applyUrl);
                });
        } else {
            void resolveMediaUrl(storageKey, fallback).then(applyUrl);
        }
        return () => {
            cancelled = true;
        };
    }, [activeNode, activeVideoClip]);

    useEffect(() => {
        const canvas = overlayCanvasRef.current;
        if (!canvas) return;
        const width = videoSize?.width || PREVIEW_WIDTH;
        const height = videoSize?.height || PREVIEW_HEIGHT;
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, width, height);
        setOverlayError("");
        let cancelled = false;
        void (async () => {
            for (const clip of activeVisualOverlays) {
                const node = nodes.find((item) => item.id === clip.nodeId);
                const direct = clip.directMedia;
                if (clip.kind === "text") {
                    try {
                        const text = clip.text || direct?.content || node?.metadata?.content || "";
                        if (!cancelled) drawTimelineOverlay(ctx, { ...clip, text }, width, height);
                    } catch (error) { if (!cancelled) setOverlayError(error instanceof Error ? error.message : "文字片段预览失败"); }
                    continue;
                }
                const storageKey = direct?.storageKey || node?.metadata?.storageKey || "";
                const fallback = direct?.dataUrl || direct?.content || direct?.url || node?.metadata?.content || "";
                try {
                    const url = await resolveMediaUrl(storageKey, fallback);
                    if (!url) throw new Error("图片素材不可读取");
                    const cacheKey = `${clip.id}:${url}`;
                    let image = overlayImagesRef.current.get(cacheKey);
                    if (!image) {
                        const response = await fetch(url);
                        if (!response.ok) throw new Error(`图片资源读取失败（${response.status}）`);
                        const blob = await response.blob();
                        const mime = direct?.mimeType || node?.metadata?.mimeType || blob.type;
                        if (!["image/png", "image/jpeg", "image/webp"].includes(mime.toLowerCase())) throw new Error(`暂不支持 ${mime || "未知"} 格式（支持 PNG、JPEG、WebP）`);
                        image = new Image();
                        image.src = url;
                        await image.decode();
                        overlayImagesRef.current.set(cacheKey, image);
                    }
                    if (!cancelled) drawTimelineOverlay(ctx, clip, width, height, image);
                } catch (error) {
                    if (!cancelled) setOverlayError(error instanceof Error ? `图片片段预览失败：${error.message}` : "图片片段预览失败");
                }
            }
        })();
        return () => { cancelled = true; };
    }, [activeVisualOverlays, nodes, videoSize]);

    // 播放/暂停与外部跳转（标尺拖动）时同步视频位置；播放前先定位到片段源内起点，
    // 避免裁剪后的片段从原始视频 0s 开始播放；播放期间视频时间反向驱动播放头，不做回跳。
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !activeVideoClip || !videoUrl) return;
        const sourceStartSec = (activeVideoClip.sourceStartMs || 0) / 1000;
        const sourceDurationSec = (activeVideoClip.sourceDurationMs || activeVideoClip.durationMs) / 1000;
        const targetSec = sourceStartSec + Math.max(0, playheadMs - activeVideoClip.startMs) / 1000;
        const clampedTargetSec = Math.min(targetSec, sourceStartSec + Math.max(0, sourceDurationSec - 0.05));
        targetSeekSecRef.current = clampedTargetSec;
        if (video.readyState >= 1 && Math.abs(video.currentTime - clampedTargetSec) > 0.05) {
            video.currentTime = clampedTargetSec;
        }
        if (playing) {
            void video.play().catch(() => undefined);
        } else {
            video.pause();
        }
    }, [activeVideoClip, playheadMs, playing, videoUrl]);

    // 视频换源后元数据加载完成，应用之前记录的源内定位目标。
    const handleVideoLoadedMetadata = (video: HTMLVideoElement) => {
        if (video.videoWidth > 0 && video.videoHeight > 0) setVideoSize({ width: video.videoWidth, height: video.videoHeight });
        if (targetSeekSecRef.current != null && video.readyState >= 1) {
            const target = Math.min(targetSeekSecRef.current, Math.max(0, (video.duration || 0) - 0.05));
            if (Math.abs(video.currentTime - target) > 0.05) video.currentTime = target;
        }
    };

    const handleTimeUpdate = () => {
        const video = videoRef.current;
        if (!video || !activeVideoClip || !playing) return;
        const sourceStartSec = (activeVideoClip.sourceStartMs || 0) / 1000;
        const timelineMs = activeVideoClip.startMs + Math.round((video.currentTime - sourceStartSec) * 1000);
        onPlayheadChange(Math.max(0, timelineMs));
        const clipEndMs = activeVideoClip.startMs + activeVideoClip.durationMs;
        if (timelineMs >= clipEndMs) {
            const next = videoClips.find((clip) => clip.startMs >= clipEndMs - AUTO_ADVANCE_GAP_MS && clip.id !== activeVideoClip.id);
            if (next) {
                onPlayheadChange(next.startMs);
            } else {
                onTogglePlay();
            }
        }
    };

    const previewDisplay = useMemo(() => {
        if (!videoSize || videoSize.height <= 0) return null;
        const ratio = videoSize.width / videoSize.height;
        let width = PREVIEW_WIDTH;
        let height = width / ratio;
        if (height > PREVIEW_HEIGHT) {
            height = PREVIEW_HEIGHT;
            width = Math.round(height * ratio);
        }
        return { width: Math.round(width), height: Math.round(height) };
    }, [videoSize]);

    return (
        <div className="flex items-center gap-3 border-b px-4 py-2.5" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
            <div className="relative grid shrink-0 place-items-center overflow-hidden rounded-lg bg-black" style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }} data-canvas-no-zoom>
                {videoUrl && activeVideoClip ? (
                    <>
                        <div className="relative" style={previewDisplay ? { width: previewDisplay.width, height: previewDisplay.height } : { width: "100%", height: "100%" }}>
                            <video ref={videoRef} className="block h-full w-full" src={videoUrl} playsInline preload="metadata" onLoadedMetadata={(event) => handleVideoLoadedMetadata(event.currentTarget)} onTimeUpdate={handleTimeUpdate} />
                            {activeSubtitleClip ? <CanvasSubtitleOverlay text={activeSubtitleClip.text || ""} highlight={activeHighlight} style={subtitleStyle} /> : null}
                        </div>
                        <button
                            type="button"
                            className="absolute inset-0 z-10 grid place-items-center"
                            aria-label={playing ? "暂停预览" : "播放预览"}
                            onClick={(event) => {
                                event.stopPropagation();
                                onTogglePlay();
                            }}
                        >
                            <span className="grid size-10 place-items-center rounded-full bg-black/45 text-white backdrop-blur transition hover:scale-105 hover:bg-black/60">
                                {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
                            </span>
                        </button>
                    </>
                ) : (
                    <div className="px-4 text-center text-xs opacity-55">该位置无视频片段</div>
                )}
                <canvas ref={overlayCanvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
                {overlayError ? <div className="absolute bottom-1 left-1 z-20 rounded bg-black/75 px-2 py-1 text-[10px] text-white">{overlayError}</div> : null}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs">
                    <span className="truncate font-semibold" style={{ color: theme.accent.primary }}>
                        {activeVideoClip?.title || "无视频片段"}
                    </span>
                    <span className="opacity-45 tabular-nums">{activeVideoClip ? `${formatTimelineTime(activeVideoClip.startMs)} ~ ${formatTimelineTime(activeVideoClip.startMs + activeVideoClip.durationMs)}` : ""}</span>
                </div>
                <div className="mt-1.5 max-h-16 min-h-10 overflow-y-auto rounded-lg border px-2.5 py-1.5 text-xs leading-5" style={{ borderColor: theme.toolbar.border, background: theme.node.fill }}>
                    {activeSubtitleClip ? activeSubtitleClip.text : <span className="opacity-40">此处无字幕，点选字幕片段后在下方编辑</span>}
                </div>
            </div>
        </div>
    );
}
