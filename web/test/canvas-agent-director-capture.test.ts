import { describe, expect, test } from "bun:test";

import { directorCanvasHasAspect, waitForDirectorCanvasAspect, waitForDirectorCaptureReady } from "@/pages/canvas/canvas-agent-director-capture";

describe("canvas Agent director capture readiness", () => {
    test("requires the actual drawing buffer dimensions to be 16:9", async () => {
        expect(directorCanvasHasAspect({ width: 1185, height: 754 })).toBe(false);
        expect(directorCanvasHasAspect({ width: 1185, height: 666 })).toBe(true);
        let size = { width: 1185, height: 754 };
        const waiting = waitForDirectorCanvasAspect(() => size, 16 / 9, 500);
        setTimeout(() => { size = { width: 1280, height: 720 }; }, 35);
        expect(await waiting).toEqual({ width: 1280, height: 720 });
    });

    test("opens the workbench and waits for its real capture handler", async () => {
        let capture: (() => string) | null = null;
        let opened = false;
        const ready = waitForDirectorCaptureReady(() => capture, () => {
            opened = true;
            setTimeout(() => { capture = () => "captured"; }, 30);
        }, () => true, 500);

        expect(opened).toBe(true);
        expect(await ready).toBe(capture);
        expect(capture?.()).toBe("captured");
    });

    test("waits for the rendered viewport after the capture handler registers", async () => {
        const capture = () => "real capture";
        let viewportReady = false;
        const pending = waitForDirectorCaptureReady(() => capture, () => { throw new Error("already open"); }, () => viewportReady, 500);
        setTimeout(() => { viewportReady = true; }, 40);
        expect(await pending).toBe(capture);
    });

    test("does not reopen an already registered workbench", async () => {
        const capture = () => "ready";
        let opened = false;
        expect(await waitForDirectorCaptureReady(() => capture, () => { opened = true; })).toBe(capture);
        expect(opened).toBe(false);
    });
});
