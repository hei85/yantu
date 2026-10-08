import { describe, expect, test } from "bun:test";

import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { resolveModelPickerOption } from "../src/lib/model-picker-groups";
import { defaultConfig, type AiConfig, type ModelChannel } from "../src/stores/use-config-store";

// 复现用户反馈的场景：选择器里部分模型是灰的、点不动，而且不说明原因。
// 这里锁定“不可用必须有具体原因”这条契约，防止回归成静默禁用。
function pickerConfig(): AiConfig {
    const variants = [
        { model: "cinema-image", operations: ["image_to_video"], maxImages: 1 },
        { model: "cinema-text", operations: ["text_to_video"], maxImages: 0 },
    ];
    const channel: ModelChannel = {
        id: "relay",
        name: "中转渠道",
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        apiFormat: "openai",
        models: variants.map((item) => item.model),
        modelCosts: variants.map((item) => {
            const capabilityConfig = defaultModelCapabilityConfig(undefined, item.model);
            capabilityConfig.video!.operations = item.operations;
            capabilityConfig.video!.references.maxImages = item.maxImages;
            return {
                model: item.model,
                displayName: "Cinema Pro",
                capability: "video" as const,
                billingMode: "per_second" as const,
                unitPriceMicrocredits: 1,
                capabilityConfig,
            };
        }),
    };
    const models = variants.map((item) => `relay::${item.model}`);
    return { ...defaultConfig, channels: [channel], models, videoModels: models, model: models[0], videoModel: models[0] };
}

const imageRequirements = {
    capability: "video" as const,
    input: { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 },
};

describe("模型选择器不可用原因", () => {
    test("带参考图时纯文生视频模型给出具体原因，而不是静默禁用", () => {
        const config = pickerConfig();
        const resolution = resolveModelPickerOption({
            config,
            models: ["relay::cinema-text"],
            requirements: imageRequirements,
            selected: false,
        });

        expect(resolution.model).toBe("");
        expect(resolution.disabledReason.length).toBeGreaterThan(0);
        expect(resolution.disabledReason).toContain("参考图");
    });

    test("兼容模型不会被标记禁用，也不会带原因", () => {
        const config = pickerConfig();
        const resolution = resolveModelPickerOption({
            config,
            models: ["relay::cinema-image"],
            requirements: imageRequirements,
            selected: false,
        });

        expect(resolution.model).toBe("relay::cinema-image");
        expect(resolution.disabledReason).toBe("");
    });

    test("没有能力要求时不应误判为不可用", () => {
        const config = pickerConfig();
        const resolution = resolveModelPickerOption({
            config,
            models: ["relay::cinema-text"],
            requirements: undefined,
            selected: false,
        });

        expect(resolution.model).toBe("relay::cinema-text");
        expect(resolution.disabledReason).toBe("");
    });
});
