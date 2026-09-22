import { describe, expect, test } from "bun:test";

import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { buildGenerationConfig } from "@/lib/canvas/canvas-project-generation";
import { createModelChannel, defaultConfig, encodeChannelModel, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType } from "@/types/canvas";

// 复现线上问题：全局「同步音频」默认开启，而所选视频模型的能力档案不支持它，
// 请求被后端合同拒绝：参数 同步音频 超出支持范围。
function videoConfig(options: { audioSupported: boolean; generateAudio: string }): AiConfig {
    const model = "minimax_h3_b99_001";
    const capabilityConfig = defaultModelCapabilityConfig("newapi-channel-2", model);
    if (capabilityConfig.video) capabilityConfig.video.generateAudio = { supported: options.audioSupported, default: false };
    const channel = createModelChannel({
        id: "CHANNEL_TEST",
        name: "测试渠道",
        baseUrl: "https://example.com",
        apiKey: "test",
        models: [model],
        modelCosts: [{
            model,
            capability: "video",
            protocol: "newapi-channel-2",
            billingMode: "fixed_request",
            unitPriceMicrocredits: 0,
            capabilityConfig,
        }],
    });
    return {
        ...defaultConfig,
        channels: [channel],
        videoModels: [encodeChannelModel("CHANNEL_TEST", model)],
        videoModel: encodeChannelModel("CHANNEL_TEST", model),
        videoGenerateAudio: options.generateAudio,
    };
}

describe("video option clamping", () => {
    test("drops 同步音频 when the selected model profile does not support it", () => {
        const config = videoConfig({ audioSupported: false, generateAudio: "true" });
        const built = buildGenerationConfig(config, undefined, "video");
        expect(built.videoGenerateAudio).toBe("false");
    });

    test("node level override still respects the model profile", () => {
        const config = videoConfig({ audioSupported: false, generateAudio: "false" });
        const node = {
            id: "node-1",
            type: CanvasNodeType.Video,
            title: "视频节点",
            position: { x: 0, y: 0 },
            width: 320,
            height: 200,
            metadata: { generateAudio: "true" },
        } as unknown as Parameters<typeof buildGenerationConfig>[1];
        const built = buildGenerationConfig(config, node, "video");
        expect(built.videoGenerateAudio).toBe("false");
    });
});
