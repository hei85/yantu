import { probeResource } from "@/services/api/resources";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import type { BackendGenerationMediaResult, BackendGenerationResult } from "@/services/api/generation-task";
import type { GenerationTask } from "@/services/api/task-center";

type RequestedRatio = { ratio: number; label: string };
type MediaDimensions = { width: number; height: number };

/** Verify the returned media itself, including resource-backed videos with no provider dimensions. */
export async function validateGenerationResultDimensions(task: GenerationTask, result: BackendGenerationResult) {
    const mode = result.mode || (task.type === "canvas_image" ? "image" : task.type === "canvas_video" ? "video" : undefined);
    if (mode !== "image" && mode !== "video") return;
    const requested = requestedRatio(task.inputJson);
    if (!requested) return;

    const media = mode === "image" ? result.images || [] : result.video ? [result.video] : [];
    for (const item of media) {
        const hasMediaSource = Boolean(resourceIdFromStorageKey(item.storageKey) || item.resourceId || item.dataUrl);
        // Provider dimensions can be stale or wrong. When the actual media is
        // available, validate its probed dimensions instead of trusting metadata.
        const dimensions = hasMediaSource ? await resolveDimensions(item, mode) : hasDimensions(item) ? item : undefined;
        if (!dimensions) throw new Error(`无法验证结果画幅（请求 ${requested.label}）：结果未提供宽高，且媒体尺寸探测失败。原始结果已保留在任务记录中。`);
        const actualRatio = dimensions.width / dimensions.height;
        if (Math.abs(actualRatio - requested.ratio) / requested.ratio > 0.08) {
            throw new Error(`请求比例 ${requested.label}，但结果实际为 ${dimensions.width}×${dimensions.height}。原始结果已保留在任务记录中。`);
        }
    }
}

function requestedRatio(inputJson?: string): RequestedRatio | undefined {
    try {
        const input = JSON.parse(inputJson || "null") as { metadata?: { requestedSize?: unknown } } | null;
        const value = input?.metadata?.requestedSize;
        if (typeof value !== "string") return undefined;
        const normalized = value.trim();
        if (!normalized || normalized.toLowerCase() === "auto") return undefined;
        const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([:：x×])\s*(\d+(?:\.\d+)?)$/i);
        if (!match) return undefined;
        const width = Number(match[1]);
        const height = Number(match[3]);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
        const isPixels = match[2] === "x" || match[2] === "×";
        return { ratio: width / height, label: isPixels ? `${match[1]}×${match[3]}` : `${match[1]}${match[2]}${match[3]}` };
    } catch {
        return undefined;
    }
}

function hasDimensions(media: BackendGenerationMediaResult): media is BackendGenerationMediaResult & MediaDimensions {
    return Number.isFinite(media.width) && Number.isFinite(media.height) && Number(media.width) > 0 && Number(media.height) > 0;
}

async function resolveDimensions(media: BackendGenerationMediaResult, mode: "image" | "video"): Promise<MediaDimensions | undefined> {
    const id = resourceIdFromStorageKey(media.storageKey) || media.resourceId;
    if (id) {
        let report;
        try {
            report = await probeResource(id);
        } catch (error) {
            const detail = error instanceof Error && error.message ? `：${error.message}` : "";
            throw new Error(`媒体尺寸探测失败，原始任务结果保留在任务记录中${detail}`);
        }
        if (report.probe.width > 0 && report.probe.height > 0) return { width: report.probe.width, height: report.probe.height };
    }
    if (!media.dataUrl || typeof document === "undefined") return undefined;
    return probeBrowserMedia(media.dataUrl, mode);
}

function probeBrowserMedia(src: string, mode: "image" | "video"): Promise<MediaDimensions | undefined> {
    return new Promise((resolve) => {
        const element = mode === "image" ? new Image() : document.createElement("video");
        const timeout = globalThis.setTimeout(() => finish(), 15_000);
        const finish = (width = 0, height = 0) => {
            globalThis.clearTimeout(timeout);
            element.onload = null;
            element.onerror = null;
            if (typeof HTMLVideoElement !== "undefined" && element instanceof HTMLVideoElement) {
                element.onloadedmetadata = null;
                element.removeAttribute("src");
                element.load();
            } else {
                element.removeAttribute("src");
            }
            resolve(width > 0 && height > 0 ? { width, height } : undefined);
        };
        if (typeof HTMLVideoElement !== "undefined" && element instanceof HTMLVideoElement) {
            element.preload = "metadata";
            element.onloadedmetadata = () => finish(element.videoWidth, element.videoHeight);
        } else {
            const image = element as HTMLImageElement;
            image.onload = () => finish(image.naturalWidth, image.naturalHeight);
        }
        element.onerror = () => finish();
        element.src = src;
    });
}
