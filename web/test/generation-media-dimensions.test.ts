import { describe, expect, test } from "bun:test";
import { validateGenerationResultDimensions } from "@/services/api/generation-media-dimensions";
import type { GenerationTask } from "@/services/api/task-center";

function task(requestedSize: string): GenerationTask {
    return {
        id: "task-1",
        type: "canvas_video",
        status: "succeeded",
        prompt: "test",
        attempts: 1,
        createdAt: "",
        updatedAt: "",
        inputJson: JSON.stringify({ metadata: { requestedSize } }),
    };
}

describe("generation result dimension validation", () => {
    test("rejects a result whose reported dimensions have the wrong orientation", async () => {
        await expect(validateGenerationResultDimensions(task("9:16"), {
            mode: "video",
            video: { width: 1920, height: 1080 },
        })).rejects.toThrow("实际为 1920×1080");
    });

    test("fails visibly when dimensions are missing and media cannot be probed", async () => {
        await expect(validateGenerationResultDimensions(task("9:16"), {
            mode: "video",
            video: { dataUrl: "data:video/mp4;base64,AA==" },
        })).rejects.toThrow("无法验证结果画幅");
    });

    test("accepts a result matching the requested orientation", async () => {
        await expect(validateGenerationResultDimensions(task("9:16"), {
            mode: "video",
            video: { width: 1080, height: 1920 },
        })).resolves.toBeUndefined();
    });

    test("uses probed media dimensions when provider metadata reports the wrong orientation", async () => {
        const OriginalImage = globalThis.Image;
        const OriginalDocument = globalThis.document;
        class ProbedImage {
            naturalWidth = 1080;
            naturalHeight = 1920;
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            removeAttribute() {}
            set src(_value: string) { this.onload?.(); }
        }
        globalThis.Image = ProbedImage as unknown as typeof Image;
        globalThis.document = {} as Document;
        try {
            await expect(validateGenerationResultDimensions(task("9:16"), {
                mode: "image",
                images: [{ width: 1920, height: 1080, dataUrl: "data:image/png;base64,AA==" }],
            })).resolves.toBeUndefined();
        } finally {
            globalThis.Image = OriginalImage;
            globalThis.document = OriginalDocument;
        }
    });
});
