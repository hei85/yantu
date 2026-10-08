import { modelCapabilityConfigFor, videoDurationAllowed } from "@/lib/model-capabilities";
import { resolveModelRequestConfig } from "@/stores/use-config-store";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { ReferenceImage } from "@/types/image";

import type { ResolvedAiConfig } from "./video-contracts";

export function assertVideoCapability(
    profile: NonNullable<ReturnType<typeof modelCapabilityConfigFor>["video"]>,
    references: ReferenceImage[],
    videoReferences: ReferenceVideo[],
    audioReferences: ReferenceAudio[],
    seconds: string,
    requestedOperation?: string,
) {
    if (references.length > profile.references.maxImages || videoReferences.length > profile.references.maxVideos || audioReferences.length > profile.references.maxAudios) throw new Error("参考素材数量超过当前模型限制");
    const operation = requestedOperation || (references.length ? "image_to_video" : videoReferences.length ? "reference_to_video" : audioReferences.length ? "audio_to_video" : "text_to_video");
    if (!profile.operations.includes(operation)) throw new Error("当前视频模型不支持该生成模式");
    if (operation === "text_to_video" && references.length) throw new Error("文生视频不能携带参考图，请移除参考图或选择图生视频模型");
    if ((operation === "image_to_video" || operation === "reference_to_video") && references.length < Math.max(operation === "image_to_video" ? 1 : 0, profile.references.minImages)) {
        throw new Error(`当前视频生成模式至少需要 ${Math.max(operation === "image_to_video" ? 1 : 0, profile.references.minImages)} 张参考图`);
    }
    if (audioReferences.length < (profile.references.minAudios || 0)) throw new Error(`当前视频模型至少需要 ${profile.references.minAudios} 段参考音频`);
    if (!videoDurationAllowed(profile, Number(seconds))) throw new Error("视频时长不在当前模型支持范围内");
    if (profile.references.maxImageBytes > 0 && references.some((image) => (image.bytes || 0) > profile.references.maxImageBytes)) throw new Error("参考图片文件超过当前模型大小限制");
    for (const video of videoReferences) {
        if (profile.references.maxVideoBytes > 0 && (video.bytes || 0) > profile.references.maxVideoBytes) throw new Error("参考视频文件超过当前模型大小限制");
        if (profile.references.maxVideoDurationSeconds > 0 && (video.durationMs || 0) > profile.references.maxVideoDurationSeconds * 1000) throw new Error("参考视频时长超过当前模型限制");
    }
    for (const audio of audioReferences) {
        if (profile.references.maxAudioBytes > 0 && (audio.bytes || 0) > profile.references.maxAudioBytes) throw new Error("参考音频文件超过当前模型大小限制");
        if (profile.references.maxAudioDurationSeconds > 0 && (audio.durationMs || 0) > profile.references.maxAudioDurationSeconds * 1000) throw new Error("参考音频时长超过当前模型限制");
    }
}

export function assertVideoConfig(config: ResolvedAiConfig, model: string) {
    if (!model) throw new Error("请先配置视频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini" && config.interfaceType !== "gemini-veo") throw new Error("当前 Gemini 文本协议不支持视频生成，请为该模型选择 Gemini Veo 协议");
}

export function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, seconds));
}

export function normalizeVideoSize(value: string) {
    const size = (value || "1280x720").trim().toLowerCase().replace("×", "x");
    if (size === "auto" || size === "adaptive") return null;
    if (/^\d+x\d+$/.test(size)) {
        const [width, height] = size.split("x").map(Number);
        if (width > 0 && height > 0) return size;
        throw new Error(`无效的视频像素尺寸：${value}`);
    }
    const ratio = size.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!ratio) throw new Error(`无法识别视频尺寸“${value}”；请使用 auto、比例（如 16:9）或像素尺寸（如 1280x720）`);
    const widthRatio = Number(ratio[1]);
    const heightRatio = Number(ratio[2]);
    if (!Number.isFinite(widthRatio) || !Number.isFinite(heightRatio) || widthRatio <= 0 || heightRatio <= 0) throw new Error(`无效的视频画幅比例：${value}`);
    const aspect = widthRatio / heightRatio;
    const width = aspect >= 1 ? 1280 : Math.max(256, Math.round((1280 * aspect) / 2) * 2);
    const height = aspect >= 1 ? Math.max(256, Math.round((1280 / aspect) / 2) * 2) : 1280;
    return `${width}x${height}`;
}

/** Convert the UI's ratio or pixel dimensions to the ratio field used by
 * video-generations APIs. Never guess a landscape default for invalid input. */
export function normalizeVideoAspectRatio(value: string): string | null {
    const raw = (value || "16:9").trim().toLowerCase().replace("×", "x");
    if (raw === "auto" || raw === "adaptive") return null;
    const ratio = raw.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/u);
    if (ratio) {
        const width = Number(ratio[1]);
        const height = Number(ratio[2]);
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return `${ratio[1]}:${ratio[2]}`;
        throw new Error(`无效的视频画幅比例：${value}`);
    }
    const dimensions = raw.match(/^(\d{2,5})x(\d{2,5})$/u);
    if (!dimensions) throw new Error(`无法识别视频画幅“${value}”；请使用比例（如 16:9）或像素尺寸（如 1280x720）`);
    const width = Number(dimensions[1]);
    const height = Number(dimensions[2]);
    if (!width || !height) throw new Error(`无效的视频像素尺寸：${value}`);
    const divisor = greatestCommonDivisor(width, height);
    return `${width / divisor}:${height / divisor}`;
}

function greatestCommonDivisor(left: number, right: number) {
    while (right !== 0) [left, right] = [right, left % right];
    return left || 1;
}

export function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    if (value.toLowerCase() === "2k") return "1440p";
    if (value.toLowerCase() === "4k") return "2160p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

export function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}
