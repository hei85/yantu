// 第三期：时间线导出运行时。把 buildTimelineRenderPlan 产出的步骤逐步在 ffmpeg.wasm 中执行，
// 复用 canvas-video-merge.ts 的 loadFFmpeg（本地同源加载 core/wasm），媒体读写与清理逻辑保持一致。

import { loadFFmpeg } from "@/lib/canvas/canvas-video-merge";
import { getMediaBlob } from "@/services/file-storage";
import type { TimelineProject } from "@/types/timeline";
import { buildTimelineRenderPlan, getOrderedOverlayClips, type TimelineRenderContext, type TimelineRenderSource } from "./timeline-to-ffmpeg";
import { rasterizeTimelineOverlay } from "./timeline-overlay";

export type TimelineExportProgress = {
    phase: "loading" | "reading" | "encoding";
    percent: number;
    detail: string;
};

export type TimelineExportOptions = {
    onProgress?: (progress: TimelineExportProgress) => void;
    context?: Partial<TimelineRenderContext>;
};

async function fetchSourceBlob(source: TimelineRenderSource): Promise<Blob> {
    if (source.storageKey) {
        const stored = await getMediaBlob(source.storageKey);
        if (stored) return stored;
    }
    if (source.url) {
        const response = await fetch(source.url);
        if (!response.ok) throw new Error("视频资源请求失败（" + response.status + "）");
        return response.blob();
    }
    throw new Error("找不到素材 " + source.nodeId + " 的媒体文件");
}

async function readVideoSize(blob: Blob): Promise<{ width: number; height: number }> {
    const url = URL.createObjectURL(blob);
    try {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.muted = true;
        video.src = url;
        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("无法读取视频画面尺寸"));
        });
        if (!video.videoWidth || !video.videoHeight) throw new Error("无法读取视频画面尺寸");
        return { width: video.videoWidth, height: video.videoHeight };
    } finally { URL.revokeObjectURL(url); }
}

function makeOverlayBurnArgs(stepArgs: string[], clips: ReturnType<typeof getOrderedOverlayClips>, hasAudio: boolean): string[] {
    const args = stepArgs.slice(0, stepArgs.indexOf("-filter_complex"));
    const inputCount = clips.length;
    clips.forEach((_, i) => args.push("-loop", "1", "-framerate", "30", "-i", `timeline-overlay-${i}.png`));
    let current = "0:v";
    const filters: string[] = [];
    clips.forEach((clip, i) => {
        const next = `v${i + 1}`;
        const start = Math.max(0, clip.startMs) / 1000;
        const end = Math.max(start, clip.startMs + clip.durationMs) / 1000;
        filters.push(`[${current}][${i + 1}:v]overlay=0:0:eof_action=pass:shortest=1:format=auto:enable='between(t,${start},${end})'[${next}]`);
        current = next;
    });
    if (hasAudio) {
        args.push("-i", "timeline-audio.m4a");
        const audioIndex = inputCount + 1;
        filters.push(`[0:a]volume=1[base];[${audioIndex}:a]volume=1[extra];[base][extra]amix=inputs=2:duration=longest:normalize=0[aout]`);
    }
    args.push("-filter_complex", filters.join(";"), "-map", `[${current}]`);
    if (hasAudio) args.push("-map", "[aout]"); else args.push("-map", "0:a?");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", stepArgs[stepArgs.length - 1]);
    return args;
}

/** 导出时间线为 MP4：写媒体 → 按计划逐步执行 → 返回 Blob（下载由调用方处理） */
export async function exportTimelineToMp4(timeline: TimelineProject, sources: TimelineRenderSource[], options: TimelineExportOptions = {}): Promise<Blob> {
    const { onProgress, context } = options;
    onProgress?.({ phase: "loading", percent: 0, detail: "加载 FFmpeg" });
    const ffmpeg = await loadFFmpeg(({ phase, progress }) => onProgress?.({ phase: phase === "loading" ? "loading" : "reading", percent: progress, detail: phase === "loading" ? "加载 FFmpeg" : "读取素材" }));
    const { fetchFile } = await import("@ffmpeg/util");
    const blobs = new Map<string, Blob>();
    for (const source of sources) if (!source.text) blobs.set(source.fileName, await fetchSourceBlob(source));
    const primaryVideo = sources.find((source) => timeline.clips.some((clip) => clip.kind === "video" && clip.id === source.clipId));
    const size = primaryVideo ? await readVideoSize(blobs.get(primaryVideo.fileName)!) : undefined;
    const plan = buildTimelineRenderPlan(timeline, sources, { ...context, ...(size || {}) });
    const writtenFiles = new Set<string>();

    try {
        for (const source of sources) {
            onProgress?.({ phase: "reading", percent: 5, detail: "读取素材 " + source.fileName });
            if (source.text) continue;
            const blob = blobs.get(source.fileName)!;
            if (source.fileName.endsWith(".image")) {
                const mime = source.mimeType || blob.type;
                if (!["image/png", "image/jpeg", "image/webp"].includes(mime.toLowerCase())) throw new Error(`图片片段 ${source.clipId || source.nodeId} 暂不支持 ${mime || "未知"} 格式（支持 PNG、JPEG、WebP）`);
            }
            await ffmpeg.writeFile(source.fileName, await fetchFile(blob));
            writtenFiles.add(source.fileName);
        }

        const executableSteps = plan.steps.filter((step) => step.kind !== "overlay");
        let stepIndex = 0;
        for (const step of plan.steps) {
            if (step.kind === "overlay") {
                const clips = getOrderedOverlayClips(timeline, context?.burnSubtitles ?? true);
                if (!size) throw new Error("无法确定视频尺寸，不能生成时间线 overlay 图层");
                for (let i = 0; i < clips.length; i++) {
                    const clip = clips[i];
                    const source = sources.find((item) => item.clipId === clip.id);
                    let image: ImageBitmap | undefined;
                    if (clip.kind === "image") {
                        const blob = source ? blobs.get(source.fileName) : undefined;
                        if (!blob) throw new Error(`图片片段 ${clip.id} 缺少可读取的图片数据`);
                        const mime = source?.mimeType || blob.type;
                        if (!["image/png", "image/jpeg", "image/webp"].includes(mime.toLowerCase())) throw new Error(`图片片段 ${clip.id} 暂不支持 ${mime || "未知"} 格式（支持 PNG、JPEG、WebP）`);
                        try { image = await createImageBitmap(blob); }
                        catch (error) { throw new Error(`图片片段 ${clip.id} 解码失败，无法安全导出`, { cause: error }); }
                    }
                    try {
                        const effectiveClip = clip.kind === "text" && !clip.text && source?.text ? { ...clip, text: source.text } : clip;
                        const png = await rasterizeTimelineOverlay(effectiveClip, size.width, size.height, image);
                        const fileName = `timeline-overlay-${i}.png`;
                        await ffmpeg.writeFile(fileName, png);
                        writtenFiles.add(fileName);
                    } finally { image?.close(); }
                }
                continue;
            }
            if (step.args.includes("concat.txt")) {
                const content = plan.concatEntries.map((file) => "file '" + file + "'").join("\n");
                await ffmpeg.writeFile("concat.txt", new TextEncoder().encode(content));
                writtenFiles.add("concat.txt");
            }
            onProgress?.({ phase: "encoding", percent: Math.round(10 + (stepIndex / Math.max(1, executableSteps.length)) * 75), detail: step.description });

            if (step.kind === "burn") {
                try {
                    const overlays = getOrderedOverlayClips(timeline, context?.burnSubtitles ?? true);
                    if (!size) throw new Error("无法确定视频尺寸，不能生成时间线 overlay 图层");
                    const exitCode = await ffmpeg.exec(["-y", ...makeOverlayBurnArgs(step.args, overlays, plan.audioSources.length > 0)]);
                    if (exitCode !== 0) throw new Error("burn exit " + exitCode);
                } catch (error) {
                    throw new Error("时间线文字/图片/字幕 overlay 烧录失败，已取消导出", { cause: error });
                }
            } else {
                const exitCode = await ffmpeg.exec(["-y", ...step.args]);
                if (exitCode !== 0) throw new Error("导出失败：" + step.description);
            }
            writtenFiles.add(step.output);
            stepIndex += 1;
        }

        const output = await ffmpeg.readFile(plan.finalOutput);
        onProgress?.({ phase: "encoding", percent: 100, detail: "导出完成" });
        return new Blob([output as BlobPart], { type: "video/mp4" });
    } finally {
        await Promise.all([...writtenFiles, "concat.txt", "timeline-audio.m4a", plan.finalOutput].map((file) => ffmpeg.deleteFile(file).catch(() => undefined)));
    }
}
