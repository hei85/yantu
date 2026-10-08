import { describe, expect, test } from "bun:test";
import { prepareBackendGenerationTask } from "../src/services/api/generation-task";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";

describe("manual channel protocol defaults", () => {
    test("a manually entered OpenAI-compatible text model uses chat completions", async () => {
        const channel = createModelChannel({ id: "manual", apiFormat: "openai", models: ["go-deepseek-v4.1-flash"] });
        const task = await prepareBackendGenerationTask({
            mode: "text",
            prompt: "你好",
            config: { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, channel.models[0]!) },
        });
        expect((task.input?.config as Record<string, unknown>)?.interfaceType).toBe("chat-completion");
    });

    test("an explicit protocol stays selected", async () => {
        const channel = createModelChannel({ id: "manual", apiFormat: "openai", models: ["text-model"], modelCosts: [{ model: "text-model", protocol: "claude-api", capability: "text" }] });
        const task = await prepareBackendGenerationTask({
            mode: "text",
            prompt: "你好",
            config: { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, channel.models[0]!) },
        });
        expect((task.input?.config as Record<string, unknown>)?.interfaceType).toBe("claude-api");
    });

    test("Gemini text keeps its native request format", async () => {
        const channel = createModelChannel({ id: "manual", apiFormat: "gemini", models: ["gemini-text"] });
        const task = await prepareBackendGenerationTask({
            mode: "text",
            prompt: "你好",
            config: { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, channel.models[0]!) },
        });
        expect(task.input?.config).toMatchObject({ interfaceType: "gemini-generate-content", apiFormat: "gemini" });
    });

    test("a manually entered image model uses the image endpoint", async () => {
        const channel = createModelChannel({ id: "manual", apiFormat: "openai", models: ["image-model"] });
        const task = await prepareBackendGenerationTask({
            mode: "image",
            prompt: "一朵花",
            config: { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, channel.models[0]!) },
        });
        expect((task.input?.config as Record<string, unknown>)?.interfaceType).toBe("openai-image");
    });

    test("video without a selected endpoint is rejected before submission", async () => {
        const channel = createModelChannel({ id: "manual", apiFormat: "openai", models: ["video-model"] });
        await expect(prepareBackendGenerationTask({
            mode: "video",
            prompt: "test",
            config: { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, channel.models[0]!) },
        })).rejects.toThrow("配置调用接口");
    });
});
