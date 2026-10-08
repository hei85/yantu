import { describe, expect, test } from "bun:test";
import { parseBackendGenerationResult, prepareBackendGenerationTask } from "../src/services/api/generation-task";
import type { GenerationTask } from "../src/services/api/task-center";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";

describe("generation task requested-size guard", () => {
    test("persists the selected image and video size in task metadata", async () => {
        for (const [mode, interfaceType] of [["image", "openai-image"], ["video", "newapi-channel-2"]] as const) {
            const channel = createModelChannel({ id: "size-guard", interfaceType, models: ["test-model"] });
            const input = await prepareBackendGenerationTask({
                mode,
                prompt: "test",
                config: { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, "test-model"), interfaceType, size: "16:9" },
            });
            expect((input.input?.metadata as Record<string, unknown>)?.requestedSize).toBe("16:9");
        }
    });

    test("rejects a result whose aspect ratio is flipped", () => {
        const task = generationTask({
            inputJson: JSON.stringify({ metadata: { requestedSize: "16:9" } }),
            resultJson: JSON.stringify({ mode: "image", images: [{ width: 1024, height: 1824 }] }),
        });
        expect(() => parseBackendGenerationResult(task)).toThrow("请求比例 16:9，但结果实际为 1024×1824");
    });

    test("reports a pixel-size request as dimensions instead of a reduced ratio", () => {
        const task = generationTask({
            inputJson: JSON.stringify({ metadata: { requestedSize: "1824x1024" } }),
            resultJson: JSON.stringify({ mode: "image", images: [{ width: 1024, height: 1824 }] }),
        });
        expect(() => parseBackendGenerationResult(task)).toThrow("请求比例 1824×1024，但结果实际为 1024×1824");
    });

    test("accepts provider dimensions that scale the requested ratio", () => {
        const task = generationTask({
            inputJson: JSON.stringify({ metadata: { requestedSize: "1824x1024" } }),
            resultJson: JSON.stringify({ mode: "image", images: [{ width: 1674, height: 940 }] }),
        });
        expect(parseBackendGenerationResult(task).images?.[0]).toMatchObject({ width: 1674, height: 940 });
    });

    test("defers mismatched provider dimensions when the media can be probed", () => {
        const task = generationTask({
            inputJson: JSON.stringify({ metadata: { requestedSize: "9:16" } }),
            resultJson: JSON.stringify({ mode: "image", images: [{ width: 1920, height: 1080, dataUrl: "data:image/png;base64,AA==" }] }),
        });
        expect(parseBackendGenerationResult(task).images?.[0]).toMatchObject({ width: 1920, height: 1080 });
    });

    test("accepts recovered tasks that have no requested-size metadata", () => {
        const task = generationTask({ resultJson: JSON.stringify({ mode: "image", images: [{ width: 1024, height: 1824 }] }) });
        expect(parseBackendGenerationResult(task).images?.[0]).toMatchObject({ width: 1024, height: 1824 });
    });
});

function generationTask(overrides: Partial<GenerationTask>): GenerationTask {
    return {
        id: "task-size-guard",
        type: "canvas_image",
        status: "succeeded",
        prompt: "test",
        attempts: 1,
        createdAt: "2026-09-29T00:00:00.000Z",
        updatedAt: "2026-09-29T00:00:00.000Z",
        ...overrides,
    };
}
