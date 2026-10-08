import type { ModelCapabilityConfig, VideoCapabilityConfig } from "@/lib/model-capabilities";

export const VIDEO_DURATION_OPTIONS = [6, 9, 10, 15] as const;
export const VIDEO_RESOLUTION_OPTIONS = [480, 720, 1080, 1440, 2160] as const;
export const VIDEO_RESOLUTION_CAPABILITY_OPTIONS = VIDEO_RESOLUTION_OPTIONS.map((value) => `${value}p`);
export const VIDEO_DURATION_MIN = 1;
export const VIDEO_RESOLUTION_DEFAULT_LABEL = "渠道默认";
export const VIDEO_RESOLUTION_DEFAULT_HINT = "当前型号未提供可选档位，生成时由渠道确定分辨率。";
export const VIDEO_RESOLUTION_INFERRED_HINT = "档位按型号自动识别，此渠道尚未实测。";

export function inferredVideoResolutionNeedsVerification(profile: Pick<VideoCapabilityConfig, "resolutionSource" | "resolutions">, observed?: ModelCapabilityConfig["observed"]) {
    if (!["model-id", "model-profile"].includes(profile.resolutionSource || "")) return false;
    return (Array.isArray(profile.resolutions) ? profile.resolutions : []).some((resolution) => {
        const details = latestVideoResolutionObservation(resolution, observed)?.details;
        // A completed negative test is still a real test. Show its mismatch
        // separately rather than continuing to describe the channel as untested.
        return !(hasActualVideoOutput(details) && details?.fullDecodePassed === true);
    });
}

function latestVideoResolutionObservation(resolution: string | number | undefined, observed?: ModelCapabilityConfig["observed"]) {
    const key = videoResolutionComparisonKey(resolution);
    return [...(Array.isArray(observed) ? observed : [])].reverse().find((item) => item?.feature === "resolution"
        && videoResolutionComparisonKey(String(item.details?.requestedResolution || "")) === key);
}

function hasActualVideoOutput(details?: Record<string, unknown>) {
    return typeof details?.taskId === "string" && details.taskId.length > 0
        && typeof details.resourceId === "string" && details.resourceId.length > 0
        && Number(details.outputWidth) > 0 && Number(details.outputHeight) > 0;
}

export function videoOutputMismatchHint(resolution: string | number | undefined, observed?: ModelCapabilityConfig["observed"]) {
    const details = latestVideoResolutionObservation(resolution, observed)?.details;
    if (!hasActualVideoOutput(details) || (details?.resolutionMatched !== false && details?.aspectRatioMatched !== false)) return "";
    const requested = [String(details?.requestedRatio || ""), formatVideoResolutionLabel(String(details?.requestedResolution || ""))].filter(Boolean).join(" · ");
    return `最近实测：请求 ${requested}，返回 ${Number(details?.outputWidth)}×${Number(details?.outputHeight)}；${details?.resolutionMatched === false ? "分辨率" : "画幅"}${details?.resolutionMatched === false && details?.aspectRatioMatched === false ? "和画幅" : ""}参数未生效。`;
}

export function normalizeVideoDuration(value: string | number | undefined) {
    const seconds = Math.floor(Number(value) || VIDEO_DURATION_OPTIONS[0]);
    return String(Math.max(VIDEO_DURATION_MIN, seconds));
}

export function normalizeVideoResolution(value: string | number | undefined) {
    const raw = String(value || "").trim();
    const token = raw.toLowerCase();
    if (!token) return "";
    if (token === "low") return "480";
    if (token === "auto" || token === "medium" || token === "high") return "720";
    if (token === "2k") return "1440";
    if (token === "4k") return "2160";
    const resolution = Number(token.replace(/p$/i, ""));
    if (Number.isFinite(resolution) && resolution > 0) return String(Math.floor(resolution));
    // Channel-declared values are opaque enums, not necessarily numeric tiers.
    // Preserve them verbatim so values such as `768p竖` remain selectable and
    // can be sent back to the provider without being collapsed to 720p.
    return raw;
}

export function normalizeVideoResolutionValue(value: string | number | undefined): string {
    return normalizeVideoResolution(value) || "720";
}

export function isVideoResolutionMatch(selected: string | undefined, target: string | undefined) {
    const s = String(selected || "").trim().toLowerCase().replace(/p$/i, "");
    const t = String(target || "").trim().toLowerCase().replace(/p$/i, "");
    if (!s && !t) return true;
    if (s === t) return true;
    if ((s === "2k" || s === "1440") && (t === "2k" || t === "1440")) return true;
    if ((s === "4k" || s === "2160") && (t === "4k" || t === "2160")) return true;
    if ((s === "768" || s === "768p") && (t === "768" || t === "768p")) return true;
    if ((s === "1080" || s === "1080p") && (t === "1080" || t === "1080p")) return true;
    if ((s === "720" || s === "720p") && (t === "720" || t === "720p")) return true;
    if ((s === "480" || s === "480p") && (t === "480" || t === "480p")) return true;
    return false;
}

export function videoResolutionComparisonKey(value: string | number | undefined) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const normalized = normalizeVideoResolution(raw);
    return /^\d+$/.test(normalized) ? `${normalized}p` : normalized.toLowerCase();
}

export function resolveVideoResolutionCapabilityValue(requested: string | number | undefined, supported: string[]) {
    const requestedKey = videoResolutionComparisonKey(requested);
    if (!requestedKey) return "";
    const exact = supported.find((value) => videoResolutionComparisonKey(value) === requestedKey);
    if (exact) return exact;
    // The relay's advertised 736P tier is its route for a standard 720P request.
    if (requestedKey === "720p") return supported.find((value) => videoResolutionComparisonKey(value) === "736p") || "";
    return "";
}

export function formatVideoResolutionLabel(value: string | number | undefined) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const normalized = normalizeVideoResolution(raw);
    if (normalized === "1440" || normalized.toLowerCase() === "2k") return "2K";
    if (normalized === "2160" || normalized.toLowerCase() === "4k") return "4K";
    if (/^\d+$/.test(normalized)) return `${normalized}P`;
    return normalized.replace(/^(\d+)p/i, "$1P");
}

export function videoDimensionsForRatioAndResolution(ratio: string | undefined, resolution: string | number | undefined) {
    const ratioMatch = String(ratio || "")
        .trim()
        .toLowerCase()
        .replace("×", "x")
        .match(/^(\d+(?:\.\d+)?)(?::|x)(\d+(?:\.\d+)?)$/);
    if (!ratioMatch) return undefined;

    const ratioWidth = Number(ratioMatch[1]);
    const ratioHeight = Number(ratioMatch[2]);
    if (!Number.isFinite(ratioWidth) || !Number.isFinite(ratioHeight) || ratioWidth <= 0 || ratioHeight <= 0) return undefined;

    const normalizedResolution = normalizeVideoResolution(resolution);
    const resolutionMatch = normalizedResolution.match(/^(\d+)(?:p)?/i);
    const shortEdge = Number(resolutionMatch?.[1]);
    if (!Number.isFinite(shortEdge) || shortEdge <= 0) return undefined;

    const aspect = ratioWidth / ratioHeight;
    if (aspect >= 1) return { width: evenDimension(shortEdge * aspect), height: shortEdge };
    return { width: shortEdge, height: evenDimension(shortEdge / aspect) };
}

function evenDimension(value: number) {
    return Math.max(2, Math.round(value / 2) * 2);
}
