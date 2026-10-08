import { describe, expect, test } from "bun:test";

import { backendProviderConfig } from "../src/services/api/generation-task";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";

function backendConfig(protocol: string, size: string) {
    const channel = createModelChannel({ id: `video-${protocol}`, interfaceType: protocol, baseUrl: "https://relay.example/v1", models: ["video-model"] });
    return backendProviderConfig({
        ...defaultConfig,
        channels: [channel],
        model: encodeChannelModel(channel.id, "video-model"),
        interfaceType: protocol,
        size,
    }, "video");
}

describe("backend video size protocol mapping", () => {
    test("legacy /videos protocol keeps ratios for model capability matching", () => {
        expect(backendConfig("newapi", "16:9")).toMatchObject({ size: "16:9" });
        expect(backendConfig("newapi", "9:16")).toMatchObject({ size: "9:16" });
        expect(backendConfig("newapi", "adaptive")).toMatchObject({ size: "adaptive" });
    });

    test("legacy /videos does not confuse a valid ratio with pixel dimensions at any resolution", () => {
        const channel = createModelChannel({ id: "video-newapi", interfaceType: "newapi", baseUrl: "https://relay.example/v1", models: ["video-model"] });
        const config = { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, "video-model"), interfaceType: "newapi", vquality: "1080p" };
        expect(backendProviderConfig({ ...config, size: "9:16" }, "video")).toMatchObject({ size: "9:16" });
        expect(backendProviderConfig({ ...config, size: "16:9" }, "video")).toMatchObject({ size: "16:9" });
    });

    test("video-generations protocol receives a ratio, including reduced custom dimensions", () => {
        expect(backendConfig("newapi-channel-2", "16:9")).toMatchObject({ size: "16:9" });
        expect(backendConfig("newapi-channel-2", "720x1280")).toMatchObject({ size: "9:16" });
        expect(backendConfig("newapi-channel-2", "1824x1024")).toMatchObject({ size: "57:32" });
    });

    test("video-generations rejects automatic ratio to avoid server-side 16:9 default", () => {
        expect(() => backendConfig("newapi-channel-2", "auto")).toThrow("要求明确画幅比例");
        expect(() => backendConfig("newapi-channel-2", "adaptive")).toThrow("要求明确画幅比例");
    });
});
