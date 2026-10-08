import { describe, expect, test } from "bun:test";
import { mergeFetchedChannelModelCosts, sanitizeChannelModelCatalogItem } from "../src/lib/channel-model-catalog";
import { defaultImageCapabilityConfig, defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { imagePresetForRatio } from "../src/lib/image-size-presets";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot } from "../src/stores/use-config-store";

describe("channel model catalog image endpoints", () => {
    test("relay resolution aliases and inference provenance survive catalogue ingestion", () => {
        const entry = sanitizeChannelModelCatalogItem({ id: "MiniMax H3-1", modelType: "video", supportedEndpointTypes: ["openai-video"], options: { resolution_name: ["768P", "2K"] }, defaultParameters: { resolutionName: "768P" }, resolutionSource: "model-profile", resolutionSourceURL: "https://platform.minimax.io/docs/api-reference/video-generation-v2-create" })!;
        const channel = createModelChannel({ id: "new-relay", apiFormat: "openai", interfaceType: "chat-completion" });
        const [model] = mergeFetchedChannelModelCosts(channel, [entry]);
        expect(model.capabilityConfig?.video).toMatchObject({ resolutions: ["768P", "2K"], defaultResolution: "768P", resolutionSource: "model-profile" });
        const rootOptions = sanitizeChannelModelCatalogItem({ id: "future-video", supportedResolutions: ["480P", "1080P"] })!;
        expect(rootOptions.options?.resolution).toEqual([{ value: "480P" }, { value: "1080P" }]);
    });
    test("a standard ID-only list imports GPT image versions and aliases with a usable image route", () => {
        const channel = createModelChannel({ id: "plain", interfaceType: "chat-completion" });
        const names = ["gpt-image-2", "gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "openai/gpt-image-2.5-flare"];
        const catalog = names.map((id) => sanitizeChannelModelCatalogItem({ id })!);
        expect(catalog.every((item) => item.modelType === "image")).toBe(true);
        const imported = mergeFetchedChannelModelCosts(channel, catalog);
        expect(imported.map((item) => item.model)).toEqual(names);
        for (const item of imported) expect(item).toMatchObject({ capability: "image", protocol: "openai-image" });
    });

    test("ID-only refresh fills missing image protocols and preserves saved custom image protocols", () => {
        const channel = createModelChannel({ id: "refresh", interfaceType: "chat-completion", modelCosts: [
            { model: "gpt-image-2", capability: "image" },
            { model: "gpt-image-2.5", capability: "image", protocol: "custom-image" },
        ] });
        const merged = mergeFetchedChannelModelCosts(channel, channel.modelCosts!.map((cost) => sanitizeChannelModelCatalogItem({ id: cost.model })!));
        expect(merged[0]).toMatchObject({ capability: "image", protocol: "openai-image" });
        expect(merged[1]).toMatchObject({ capability: "image", protocol: "custom-image" });
    });
    test("a new OpenAI relay imports list-only text, image and standard speech models", () => {
        const channel = createModelChannel({ id: "another-relay", apiFormat: "openai", interfaceType: "chat-completion" });
        const catalog = ["vendor/deepseek-r1", "custom-text-alias", "qwen-image", "flux-1-pro", "tts-1", "gpt-4o-mini-tts"].map((id) => sanitizeChannelModelCatalogItem({ id })!);
        const imported = mergeFetchedChannelModelCosts(channel, catalog);
        expect(imported.map((entry) => [entry.capability, entry.protocol])).toEqual([
            ["text", "chat-completion"], ["text", "chat-completion"],
            ["image", "openai-image"], ["image", "openai-image"],
            ["audio", "openai-audio"], ["audio", "openai-audio"],
        ]);
        expect(mergeFetchedChannelModelCosts(channel, ["private-video", "indextts2-v1", "text-embedding-3-small"].map((id) => sanitizeChannelModelCatalogItem({ id })!))).toEqual([]);
    });
    test("endpoint paths and declared image aliases work without replacing private protocols", () => {
        const channel = createModelChannel({ id: "another-relay", apiFormat: "openai", interfaceType: "chat-completion" });
        expect(mergeFetchedChannelModelCosts(channel, [
            sanitizeChannelModelCatalogItem({ id: "new-art", modelType: "image", supportedEndpointTypes: ["generate", "edit"] })!,
            sanitizeChannelModelCatalogItem({ id: "new-image", supportedEndpointTypes: ["/v1/images/generations"] })!,
            sanitizeChannelModelCatalogItem({ id: "new-voice", supportedEndpointTypes: ["POST /v1/audio/speech"] })!,
        ]).map((item) => [item.capability, item.protocol])).toEqual([["image", "openai-image"], ["image", "openai-image"], ["audio", "openai-audio"]]);
        expect(mergeFetchedChannelModelCosts(channel, [sanitizeChannelModelCatalogItem({ id: "gpt-image-2", modelType: "image", supportedEndpointTypes: ["private-image-api"] })!])).toEqual([]);
    });
    test("preserves literal catalog display names and descriptions on new and existing models", () => {
        const channel = createModelChannel({ id: "named", interfaceType: "chat-completion", models: ["existing"] });
        const item = sanitizeChannelModelCatalogItem({
            id: "existing", model_type: "video", supported_endpoint_types: ["openai-video"],
            displayName: "Cinema H3", description: "Provider supplied model description.",
        })!;
        expect(item).toMatchObject({ displayName: "Cinema H3", description: "Provider supplied model description." });
        const merged = mergeFetchedChannelModelCosts(channel, [item]);
        expect(merged[0]).toMatchObject({ model: "existing", displayName: "Cinema H3", description: "Provider supplied model description." });

        const refreshed = mergeFetchedChannelModelCosts(createModelChannel({
            id: "named", interfaceType: "newapi-channel-2", models: ["existing"],
            modelCosts: [{ model: "existing", capability: "video", protocol: "newapi-channel-2" }],
        }), [sanitizeChannelModelCatalogItem({ id: "existing", displayName: "Cinema H3", description: "Provider supplied model description." })!]);
        expect(refreshed[0]).toMatchObject({ displayName: "Cinema H3", description: "Provider supplied model description." });
    });

    test("imports relay dialogue observations without losing capability or unrelated evidence", () => {
        const dialogue = {
            feature: "dialogue",
            source: "yingce_h3_asr_audit",
            reason: "适合对白对话（需音频）",
            details: { sampleCount: 1, taskId: "relay-task", referenceAudio: true, humanClarity: "unverified" },
        };
        const profile = defaultModelCapabilityConfig("newapi", "relay-video");
        profile.observed = [
            { feature: "resolution", source: "media_probe", reason: "480P" },
            { feature: "dialogue", source: "yingce_h3_asr_audit", reason: "旧结论", details: { sampleCount: 1 } },
        ];
        const item = sanitizeChannelModelCatalogItem({
            id: "relay-video",
            model_type: "video",
            supported_endpoint_types: ["openai-video"],
            description: "一段由 relay 提供的模型说明",
            yingce: { observed: [dialogue] },
        })!;
        const channel = createModelChannel({
            id: "rotating-relay-channel-id",
            interfaceType: "chat-completion",
            modelCosts: [{ model: "relay-video", capability: "video", protocol: "newapi", capabilityConfig: profile }],
        });

        expect(item.observed).toEqual([dialogue]);
        const merged = mergeFetchedChannelModelCosts(channel, [item])[0]!;
        expect(merged.description).toBe("一段由 relay 提供的模型说明");
        expect(merged.capabilityConfig?.video).toEqual(profile.video);
        expect(merged.capabilityConfig?.observed).toEqual([
            { feature: "resolution", source: "media_probe", reason: "480P" },
            dialogue,
        ]);
        const imported = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [{ ...channel, modelCosts: [merged] }] } }).config;
        expect(imported.channels.find((candidate) => candidate.id === channel.id)?.modelCosts?.[0]?.capabilityConfig?.observed).toEqual(merged.capabilityConfig?.observed);
    });

    test("image-generation and image-edit endpoints infer image models in a mixed channel", () => {
        const channel = createModelChannel({ id: "mixed", interfaceType: "chat-completion", models: [] });
        const catalog = [
            sanitizeChannelModelCatalogItem({ id: "video-model", supported_endpoint_types: ["openai-video"] }),
            sanitizeChannelModelCatalogItem({ id: "image-model", supported_endpoint_types: ["openai", "image-generation", "image-edit"] }),
        ].filter((item) => item !== null);

        const merged = mergeFetchedChannelModelCosts(channel, catalog);
        expect(merged.find((item) => item.model === "video-model")).toMatchObject({ capability: "video", protocol: "newapi" });
        expect(merged.find((item) => item.model === "image-model")).toMatchObject({ capability: "image", protocol: "openai-image" });
    });

    test("existing image profile survives a catalog refresh without image options", () => {
        const profile = defaultImageCapabilityConfig("openai-image", "image-model");
        profile.size = { parameter: "size", values: ["7x5"], default: "7x5", allowCustom: false };
        const channel = createModelChannel({
            id: "mixed",
            interfaceType: "chat-completion",
            modelCosts: [{ model: "image-model", capability: "image", protocol: "openai-image", capabilityConfig: { version: 1, image: profile } }],
        });
        const refreshed = mergeFetchedChannelModelCosts(channel, [
            sanitizeChannelModelCatalogItem({ id: "image-model", supported_endpoint_types: ["image-generation"] })!,
        ]);

        expect(refreshed[0]?.capabilityConfig?.image).toEqual(profile);
        expect(refreshed[0]).toMatchObject({ capability: "image", protocol: "openai-image" });
    });

    test("structured size enums disable custom values unless the catalog explicitly includes a wildcard", () => {
        const channel = createModelChannel({ id: "image", interfaceType: "chat-completion" });
        const closed = mergeFetchedChannelModelCosts(channel, [
            sanitizeChannelModelCatalogItem({ id: "closed", model_type: "image", options: { size: [{ value: "1024x1024" }, { value: "1824x1024" }] } })!,
        ])[0]?.capabilityConfig?.image?.size;
        expect(closed).toMatchObject({ parameter: "size", values: ["1024x1024", "1824x1024"], allowCustom: false });

        const open = mergeFetchedChannelModelCosts(channel, [
            sanitizeChannelModelCatalogItem({ id: "open", supported_endpoint_types: ["image-generation"], default_parameters: { size: "1024x1024" }, options: { size: [{ value: "1024x1024" }, { value: "*" }] } })!,
        ])[0]?.capabilityConfig?.image?.size;
        expect(open).toMatchObject({ parameter: "size", values: ["1024x1024", "*"], default: "1024x1024", allowCustom: true });
    });

    test("default image parameters without an options enum do not become a one-value limit", () => {
        const channel = createModelChannel({ id: "image", interfaceType: "chat-completion" });
        const merged = mergeFetchedChannelModelCosts(channel, [
            sanitizeChannelModelCatalogItem({ id: "image-model", supported_endpoint_types: ["image-generation"], default_parameters: { size: "1024x1024" } })!,
        ]);
        expect(merged[0]?.capabilityConfig?.image?.size).toMatchObject({ default: "1:1", allowCustom: true });
        expect(merged[0]?.capabilityConfig?.image?.size?.values).toContain("1824x1024");
    });

    test("snake_case image option and default fields are normalized", () => {
        const channel = createModelChannel({ id: "image", interfaceType: "chat-completion" });
        const merged = mergeFetchedChannelModelCosts(channel, [
            sanitizeChannelModelCatalogItem({
                id: "snake-image",
                supported_endpoint_types: ["image-generation"],
                default_parameters: { aspect_ratio: "9:16" },
                options: { aspect_ratio: [{ value: "16:9" }, { value: "9:16" }] },
            })!,
        ]);
        expect(merged[0]?.capabilityConfig?.image?.size).toMatchObject({ parameter: "aspect_ratio", values: ["16:9", "9:16"], default: "9:16", allowCustom: false });
    });

    test("conflicting catalog metadata cannot invent a new route or replace a saved contract", () => {
        const channel = createModelChannel({ id: "mixed", interfaceType: "chat-completion" });
        const merged = mergeFetchedChannelModelCosts(channel, [
            sanitizeChannelModelCatalogItem({ id: "declared-image", model_type: "image", supported_endpoint_types: ["openai-video"] })!,
            sanitizeChannelModelCatalogItem({ id: "declared-video", model_type: "video", supported_endpoint_types: ["image-generation"] })!,
        ]);
        expect(merged.find((item) => item.model === "declared-image")).toBeUndefined();
        expect(merged.find((item) => item.model === "declared-video")).toBeUndefined();

        const staleChannel = createModelChannel({
            id: "mixed",
            interfaceType: "chat-completion",
            modelCosts: [{ model: "changed-to-image", capability: "video", protocol: "newapi" }],
        });
        const corrected = mergeFetchedChannelModelCosts(staleChannel, [
            sanitizeChannelModelCatalogItem({ id: "changed-to-image", model_type: "image", supported_endpoint_types: ["openai-video"] })!,
        ]);
        expect(corrected[0]).toMatchObject({ capability: "video", protocol: "newapi" });
    });

    test("migrates only Axon's stale square-only profile when the catalog has no structured size options", () => {
        const stale = defaultModelCapabilityConfig("openai-image", "gpt-image-2");
        stale.image!.size = {
            parameter: "size",
            values: ["1:1"],
            default: "1:1",
            allowCustom: false,
            presets: [imagePresetForRatio("1k", "1:1")],
        };
        const target = createModelChannel({
            id: "verified-axon",
            baseUrl: "https://zh.heihan.dpdns.org/v1",
            interfaceType: "chat-completion",
            models: ["gpt-image-2"],
            modelCosts: [{ model: "gpt-image-2", capability: "image", protocol: "openai-image", capabilityConfig: stale }],
        });
        const unrelated = createModelChannel({
            id: "unrelated",
            baseUrl: "https://api.example.com/v1",
            interfaceType: "chat-completion",
            models: ["gpt-image-2"],
            modelCosts: [{ model: "gpt-image-2", capability: "image", protocol: "openai-image", capabilityConfig: structuredClone(stale) }],
        });
        const normalized = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [target, unrelated] } }).config;
        const targetSize = normalized.channels[0]?.modelCosts?.[0]?.capabilityConfig?.image?.size;
        const unrelatedSize = normalized.channels[1]?.modelCosts?.[0]?.capabilityConfig?.image?.size;

        expect(targetSize).toMatchObject({ values: ["1:1", "1024x1024", "1824x1024"], default: "1:1", allowCustom: false });
        expect(targetSize?.presets?.map((preset) => preset.size)).toEqual(["1024x1024", "1824x1024"]);
        expect(unrelatedSize).toEqual(stale.image?.size);

        const refreshed = mergeFetchedChannelModelCosts(target, [
            sanitizeChannelModelCatalogItem({ id: "gpt-image-2", supported_endpoint_types: ["openai", "image-generation", "image-edit"] })!,
        ]);
        expect(refreshed[0]?.capabilityConfig?.image?.size?.values).toEqual(["1:1", "1024x1024", "1824x1024"]);
    });

    test("does not guess a video endpoint for an unconfigured video catalog entry", () => {
        const unknownChannel = createModelChannel({ id: "unknown", interfaceType: "chat-completion" });
        const unknown = mergeFetchedChannelModelCosts(unknownChannel, [
            sanitizeChannelModelCatalogItem({ id: "new-video", model_type: "video" })!,
        ]);
        expect(unknown).toEqual([]);

        const configuredChannel = createModelChannel({ id: "configured", interfaceType: "newapi-channel-2" });
        const configured = mergeFetchedChannelModelCosts(configuredChannel, [
            sanitizeChannelModelCatalogItem({ id: "new-video", model_type: "video" })!,
        ]);
        expect(configured[0]).toMatchObject({ capability: "video", protocol: "newapi-channel-2" });
    });
});
