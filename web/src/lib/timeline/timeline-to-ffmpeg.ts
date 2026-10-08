// 第三期：时间线 → FFmpeg 命令序列的纯函数规划层。
// 不直接调用 FFmpeg，只产出可执行的参数计划，方便单测与运行时逐步执行；
// 运行时负责把媒体源和浏览器生成的透明字幕图层写入 ffmpeg 工作区并执行参数计划。
// 数据流：TimelineProject + 节点媒体 → trim → concat → 透明 PNG 字幕图层 → overlay。

import type { TimelineClip, TimelineProject } from "@/types/timeline";

export type TimelineRenderSource = {
  nodeId: string;
  /** Stable timeline clip identity; preferred when resolving repeated node usages. */
  clipId?: string;
    /** 已写入 ffmpeg 工作区的文件名（如 input-0.mp4） */
    fileName: string;
    durationMs: number;
    /** 媒体定位（运行时用）：本地缓存 storageKey 或远程资源地址，至少提供一个 */
    storageKey?: string;
    url?: string;
    mimeType?: string;
    text?: string;
};

export type TimelineRenderStep = {
    kind: "trim" | "gap" | "concat" | "overlay" | "burn" | "audio" | "mux";
    /** 本步骤输出文件名 */
    output: string;
    /** ffmpeg 参数数组（不含可执行文件名与 -y 覆盖参数） */
    args: string[];
    description: string;
};

export type TimelineRenderContext = {
    width: number;
    height: number;
    fps: number;
    /** 是否烧录字幕；false 时跳过 burn 步骤 */
    burnSubtitles: boolean;
    /** 最终输出文件名 */
  outputName: string;
};

export type TimelineRenderPlan = {
    steps: TimelineRenderStep[];
    finalOutput: string;
    /** concat 输入文件列表（trim/gap 输出），运行时据此写 concat.txt */
  concatEntries: string[];
  /** Active independent audio clips required by the audio mix step. */
  audioSources: TimelineRenderSource[];
};

export const SUBTITLE_PLAN_MARKER = "timeline-overlays";

export function getOrderedVideoClips(timeline: TimelineProject): TimelineClip[] {
    return timeline.clips
        .filter((clip) => clip.kind === "video")
        .slice()
        .sort((a, b) => a.startMs - b.startMs || a.trackId.localeCompare(b.trackId));
}

export function getOrderedSubtitleClips(timeline: TimelineProject): TimelineClip[] {
    return timeline.clips
        .filter((clip) => clip.kind === "subtitle")
        .slice()
        .sort((a, b) => a.startMs - b.startMs || a.trackId.localeCompare(b.trackId));
}

export function getOrderedOverlayClips(timeline: TimelineProject, includeSubtitles = true): TimelineClip[] {
    const order = new Map(timeline.tracks.map((track) => [track.id, track.order]));
    return timeline.clips.filter((clip) => (clip.kind === "subtitle" && includeSubtitles && Boolean(clip.text?.trim())) || clip.kind === "text" || clip.kind === "image")
        .filter((clip) => timeline.tracks.find((track) => track.id === clip.trackId)?.visible !== false && clip.durationMs > 0)
        .slice().sort((a, b) => Number(a.kind === "subtitle") - Number(b.kind === "subtitle") || (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0) || a.startMs - b.startMs || a.id.localeCompare(b.id));
}

function defaultContext(): TimelineRenderContext {
    return { width: 1920, height: 1080, fps: 30, burnSubtitles: true, outputName: "export.mp4" };
}

/**
 * 生成导出计划。
 * 视频轨按 startMs 顺序裁切并补齐空隙（lavfi 黑场 + 静音），最后 concat；
 * 字幕轨独立生成透明 PNG 图层并在末步 overlay，音频轨按现有片段混入。
 */
export function buildTimelineRenderPlan(timeline: TimelineProject, sources: TimelineRenderSource[], context: Partial<TimelineRenderContext> = {}): TimelineRenderPlan {
    const cfg: TimelineRenderContext = { ...defaultContext(), ...context };
    const sourceByClip = new Map(sources.filter((item) => item.clipId).map((item) => [item.clipId!, item]));
    const sourceByNode = new Map(sources.filter((item) => !item.clipId).map((item) => [item.nodeId, item]));
    const sourceFor = (clip: TimelineClip) => sourceByClip.get(clip.id) ?? sourceByNode.get(clip.nodeId);
    const steps: TimelineRenderStep[] = [];
    const concatEntries: string[] = [];
    const videoClips = getOrderedVideoClips(timeline);

    // 1)+2) 逐片段裁切，并按时间线顺序在片段前补黑场（含静音音轨），输出统一编码便于 concat。
    // 黑场必须插入对应片段之前的 concat 位置：concat 按列表顺序拼接，若先收完所有 trim 再把 gap 追加到
    // 结尾，任何存在空隙的时间线（如 A(0-15s) 与 B(25-40s) 之间的 10s）都会把黑场拼到片尾、字幕整体错位。
    // 无源片段（如节点已被删除）既不产 trim 也不补自己的黑场，直接跳过：cursor 不推进，其跨度由下一个
    // 有源片段前的单个 gap 统一覆盖。若先为无源片段补 gap 再等 cursor，同一段空隙会被重复计长、成片超长
    // （线上实锤：缺源片段前有空隙时黑场翻倍、字幕继续漂移）。
    let cursorMs = 0;
    videoClips.forEach((clip, index) => {
        const source = sourceFor(clip);
        if (!source) return;
        const gapMs = clip.startMs - cursorMs;
        if (gapMs > 100) {
            const output = `gap-${index}.mp4`;
            const durationSec = gapMs / 1000;
            steps.push({
                kind: "gap",
                output,
                args: [
                    "-f",
                    "lavfi",
                    "-i",
                    `color=c=black:s=${cfg.width}x${cfg.height}:r=${cfg.fps}:d=${durationSec}`,
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=44100:cl=stereo",
                    "-t",
                    String(durationSec),
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "20",
                    "-c:a",
                    "aac",
                    "-shortest",
                    output,
                ],
                description: `补黑场 ${(gapMs / 1000).toFixed(2)}s`,
            });
            concatEntries.push(output);
        }
        const output = `trim-${index}.mp4`;
        // 裁切时长取时间线片段时长（clip.durationMs），而不是源素材剩余时长：
        // 左缘裁剪后 sourceStartMs 前移但 sourceDurationMs 仍为源全长，若按源时长 -t 会把旧片段尾部多裁出来，
        // 表现为「裁剪后播放仍从最原始视频开始/出现旧片段」；-ss 已定位源内起点，-t 必须等于片段展示时长。
        // -ss 必须放在 -i 之后（输出 seek）：放在 -i 之前是输入 seek，MP4/H.264 只会定位到目标时间戳
        // 之前最近的关键帧，切点会偏移最多一个 GOP（常见 0.5-2s）、片尾被 -t 截掉、音视频在切点处错位。
        // 本步骤已 -c:v libx264 重编码，输出 seek 帧精确，代价只是多解码。
        const durationSec = Math.max(0.1, clip.durationMs / 1000);
        steps.push({
            kind: "trim",
            output,
            args: ["-i", source.fileName, "-ss", String((clip.sourceStartMs || 0) / 1000), "-t", String(durationSec), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "128k", output],
            description: `裁切片段 ${index + 1}（${clip.title || clip.nodeId}）`,
        });
        concatEntries.push(output);
        cursorMs = clip.startMs + clip.durationMs;
    });

    const visibleTrack = new Map(timeline.tracks.map((track) => [track.id, track]));
    const activeAudio = timeline.clips.filter((clip) => clip.kind === "audio" && visibleTrack.get(clip.trackId)?.visible !== false && !visibleTrack.get(clip.trackId)?.muted);
    const audioSources = activeAudio.map((clip) => {
        const source = sourceFor(clip);
        if (!source) throw new Error(`音频片段 ${clip.id} 缺少媒体源`);
        return source;
    });
    if (activeAudio.length) {
        const args: string[] = [];
        audioSources.forEach((source) => args.push("-i", source.fileName));
        const filters = activeAudio.flatMap((clip, i) => {
            const start = Math.max(0, clip.startMs) / 1000;
            const delay = Math.round(start * 1000);
            const duration = Math.max(0.001, clip.durationMs / 1000);
            const volume = Math.max(0, clip.volume ?? 1);
            const fadeIn = Math.max(0, Math.min(duration, (clip.fadeInMs ?? 0) / 1000));
            const fadeOut = Math.max(0, Math.min(duration, (clip.fadeOutMs ?? 0) / 1000));
            const chain = [`atrim=start=${Math.max(0, clip.sourceStartMs ?? 0) / 1000}:duration=${duration}`, `asetpts=PTS-STARTPTS`, `volume=${volume}`];
            if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${fadeIn}`);
            if (fadeOut > 0) chain.push(`afade=t=out:st=${Math.max(0, duration - fadeOut)}:d=${fadeOut}`);
            chain.push(`adelay=${delay}|${delay}`);
            return [`[${i}:a]${chain.join("," )}[a${i}]`];
        });
        if (audioSources.length) {
            filters.push(`${audioSources.map((_, i) => `[a${i}]`).join("")}amix=inputs=${audioSources.length}:duration=longest:normalize=0[aout]`);
            steps.push({ kind: "audio", output: "timeline-audio.m4a", args: [...args, "-filter_complex", filters.join(";"), "-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "timeline-audio.m4a"], description: "混合独立音频轨" });
        }
    }
    // 3) concat 拼接视频轨。
    const concatOutput = "timeline-video.mp4";
    if (concatEntries.length) {
        steps.push({
            kind: "concat",
            output: concatOutput,
            args: ["-f", "concat", "-safe", "0", "-i", "concat.txt", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", concatOutput],
            description: "拼接视频轨",
        });
    }

    // 4) 字幕轨 → 透明 PNG 图层（运行时由浏览器 Canvas 绘制）。保留 subtitle 计划标记供执行层取字幕。
    const overlayClips = getOrderedOverlayClips(timeline, cfg.burnSubtitles);
    for (const clip of overlayClips) {
        if (clip.kind === "text" && !(clip.text ?? clip.directMedia?.content ?? clip.directMedia?.dataUrl ?? sourceFor(clip)?.text ?? "").trim()) throw new Error(`文字片段 ${clip.id} 缺少文本内容`);
        if (clip.kind === "image" && !sourceFor(clip)) throw new Error(`图片片段 ${clip.id} 缺少图片素材源`);
    }
    if (overlayClips.length) {
        steps.push({
            kind: "overlay",
            output: SUBTITLE_PLAN_MARKER,
            args: [],
            description: "生成时间线文字、图片与字幕图层",
        });
    }

    // 5) 烧录字幕并输出最终文件（执行层用 overlay 滤镜）。
    const finalOutput = cfg.outputName;
    if (concatEntries.length && steps.some((step) => step.kind === "overlay")) {
        steps.push({
            kind: "burn",
            output: finalOutput,
            args: ["-i", concatOutput, "-filter_complex", "[0:v]null[vout]", "-map", "[vout]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", finalOutput],
            description: "烧录字幕并输出",
        });
    } else if (concatEntries.length && audioSources.length) {
        steps.push({ kind: "mux", output: finalOutput, args: ["-i", concatOutput, "-i", "timeline-audio.m4a", "-filter_complex", "[0:a]volume=1[base];[1:a]volume=1[extra];[base][extra]amix=inputs=2:duration=longest:normalize=0[aout]", "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", finalOutput], description: "输出成片并混入独立音频" });
    } else if (concatEntries.length) {
        steps.push({
            kind: "concat",
            output: finalOutput,
            args: ["-i", concatOutput, "-c", "copy", finalOutput],
            description: "输出成片（无字幕）",
        });
    }

    return { steps, finalOutput, concatEntries, audioSources };
}

/** 供导出对话框/文档展示的人类可读命令预览 */
export function describeRenderPlan(plan: TimelineRenderPlan): string {
    return plan.steps.map((step) => `# ${step.description}\nffmpeg -y ${step.args.join(" ")}`).join("\n\n");
}
