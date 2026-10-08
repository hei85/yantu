import { describe, expect, test } from "bun:test";
import type { TimelineClip } from "@/types/timeline";
import { drawTimelineOverlay, timelineOverlayRect } from "@/lib/timeline/timeline-overlay";

const clip = (kind: "text" | "image", overlay?: TimelineClip["overlay"]): TimelineClip => ({ id: kind, kind, nodeId: "n1", trackId: kind, startMs: 10, durationMs: 100, text: kind === "text" ? "Hello" : undefined, overlay });

describe("timeline overlay layout", () => {
    test("uses normalized persisted rectangles and kind defaults", () => {
        expect(timelineOverlayRect(clip("image"))).toEqual({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
        expect(timelineOverlayRect(clip("text"))).toEqual({ x: 0.05, y: 0.72, width: 0.9, height: 0.22 });
        expect(timelineOverlayRect(clip("text", { x: 0.2, y: 0.3, width: 0.4, height: 0.2 }))).toEqual({ x: 0.2, y: 0.3, width: 0.4, height: 0.2 });
        expect(() => timelineOverlayRect(clip("image", { x: 0.8, y: 0, width: 0.3, height: 0.5 }))).toThrow("不得越出画面");
    });

    test("draws image with contain geometry and text in its normalized area", () => {
        const calls: unknown[][] = [];
        const context = {
            drawImage: (...args: unknown[]) => calls.push(["image", ...args]),
            fillRect: (...args: unknown[]) => calls.push(["fill", ...args]),
            measureText: (value: string) => ({ width: value.length * 10 }),
            strokeText: (...args: unknown[]) => calls.push(["stroke", ...args]),
            fillText: (...args: unknown[]) => calls.push(["text", ...args]),
        } as unknown as CanvasRenderingContext2D;
        drawTimelineOverlay(context, clip("image"), 1000, 500, { width: 100, height: 100 } as CanvasImageSource & { width: number; height: number });
        expect(calls[0]).toEqual(["image", expect.anything(), 300, 50, 400, 400]);
        calls.length = 0;
        drawTimelineOverlay(context, clip("text"), 1000, 500);
        expect(calls.some((call) => call[0] === "fill" && call[1] === 50 && call[2] === 360 && call[3] === 900 && call[4] === 110)).toBe(true);
        expect(calls.some((call) => call[0] === "text" && call[1] === "Hello")).toBe(true);
    });
});
