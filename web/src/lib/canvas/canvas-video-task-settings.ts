import type { CanvasNodeMetadata } from "@/types/canvas";

/** Keep a submitted task's video settings on its node, rather than borrowing
 * the currently selected global defaults when the result is opened later. */
export function submittedVideoSettingsMetadata(inputJson?: string): Partial<CanvasNodeMetadata> {
    if (!inputJson) return {};
    try {
        const input = JSON.parse(inputJson);
        if (input?.mode !== "video" || !input.config || typeof input.config !== "object") return {};
        const out: Partial<CanvasNodeMetadata> = {};
        for (const [source, target] of [["vquality", "vquality"], ["size", "size"], ["videoSeconds", "seconds"]] as const) {
            const value = input.config[source];
            if ((typeof value === "string" || typeof value === "number") && String(value).trim()) {
                out[target] = String(value).trim();
            }
        }
        return out;
    } catch { return {}; }
}

/** Only infer standard output grades from real dimensions, never from a
 * global preference or the preview thumbnail. Unknown dimensions stay unknown. */
export function measuredVideoResolution(width?: number, height?: number): string | undefined {
    if (!width || !height || width <= 0 || height <= 0) return undefined;
    const shortSide = Math.min(width, height);
    return [480, 720, 736, 768, 1080, 1440, 2160].includes(shortSide) ? `${shortSide}p` : undefined;
}
