import { describe, expect, test } from "bun:test";
import { defaultModelCapabilityConfig, normalizeVideoValue, resolveVideoRatioValue, resolveVideoResolutionValue, videoResolutionRequest, type ModelCapabilityConfig } from "../src/lib/model-capabilities";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot } from "../src/stores/use-config-store";
import { groupModelsForPicker, resolveModelPickerOption } from "../src/lib/model-picker-groups";

// Exact nullable fields returned for MiniMax H3-1 in the local /api/model-catalog.
function nullableVideoCatalogEntry(): ModelCapabilityConfig {
    const config = defaultModelCapabilityConfig("newapi", "MiniMax H3-1");
    config.image = null as never;
    config.text = null as never;
    config.audio = null as never;
    config.observed = null as never;
    config.video!.resolutions = null as never;
    config.video!.defaultResolution = null as never;
    config.video!.duration = { selection: "range", min: 1, max: 15, step: 1, default: 5, values: null as never };
    return config;
}

describe("nullable model catalog at selection boundaries", () => {
    test("switching video settings accepts the actual nullable resolution list", () => {
        const value = normalizeVideoValue(nullableVideoCatalogEntry().video!, { seconds: "2", ratio: "16:9", resolution: "480P" });
        expect(value.seconds).toBe("2");
        expect(value.ratio).toBe("16:9");
        expect(value.resolution).toBe("");
    });

    test("public resolution and ratio helpers also accept unnormalized JSON", () => {
        const profile = nullableVideoCatalogEntry().video!;
        expect(videoResolutionRequest(profile, "480P")).toBeUndefined();
        expect(resolveVideoResolutionValue(profile, "480P")).toBe("");
        profile.ratios = null as never;
        profile.defaultRatio = null as never;
        expect(resolveVideoRatioValue(profile, "16:9")).toBe("");
    });

    test("null lists stay unsupported rather than inventing a resolution tier", () => {
        const profile = nullableVideoCatalogEntry().video!;
        const value = normalizeVideoValue(profile, { resolution: "1080P" });
        expect(value.resolution).toBe("");
        expect(profile.resolutions).toBeNull();
    });

    test("channel input normalizes capability arrays before they enter the store", () => {
        const raw = nullableVideoCatalogEntry();
        const channel = createModelChannel({ id: "axon", name: "Axon", models: ["MiniMax H3-1"], modelCosts: [{ model: "MiniMax H3-1", capability: "video", protocol: "newapi", capabilityConfig: raw }] });
        const saved = channel.modelCosts![0].capabilityConfig!;
        expect(saved.video!.resolutions).toEqual([]);
        expect(saved.video!.defaultResolution).toBe("");
        expect(saved.video!.duration.values).toBeUndefined();
        expect(raw.video!.resolutions).toBeNull();
    });

    test("all picker options remain renderable after a nullable model is selected", () => {
        const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [{ id: "axon", name: "Axon", baseUrl: "/api/ai/system/axon", apiKey: "system", apiFormat: "openai", scope: "system", models: ["MiniMax H3-1"], modelCosts: [{ model: "MiniMax H3-1", capability: "video", protocol: "newapi", capabilityConfig: nullableVideoCatalogEntry() }] }] } }).config;
        const groups = groupModelsForPicker(config, config.models);
        expect(groups).toHaveLength(1);
        const option = resolveModelPickerOption({ config, models: groups[0].models[0].models, current: config.models[0], selected: true, requirements: { capability: "video", input: { textCount: 1, imageCount: 0, videoCount: 0, audioCount: 0, characterCount: 0 } } });
        expect(option.disabledReason).toBe("");
        expect(option.model).toBe("axon::MiniMax H3-1");
    });
});
