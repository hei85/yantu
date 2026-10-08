import { describe, expect, test } from "bun:test";

import { modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import type { VideoProviderDeps } from "../src/services/api/video-provider-deps";
import { createMiniMaxVideoTask, pollMiniMaxVideoTask } from "../src/services/api/video-provider-minimax";
import { videoResponseTools } from "../src/services/api/video-response";
import { assertVideoCapability } from "../src/services/api/video-validation";

const model = "CHANNEL_000002::minimax_h3_b99_001";
const modelName = "minimax_h3_b99_001";

const capability = modelCapabilityConfigFor({
    channels: [{
        id: "CHANNEL_000002",
        models: [modelName],
        modelCosts: [{ model: modelName, protocol: "minimax-video" as never }],
    }],
}, model);

function relayConfig(overrides: Record<string, unknown> = {}) {
    return {
        baseUrl: "https://relay.example.com",
        apiKey: "test-key",
        model,
        videoModel: model,
        videoSeconds: "12",
        size: "16:9",
        vquality: "768P",
        videoWatermark: false,
        ...overrides,
    } as never;
}

type CapturedCall = { method: "post" | "get"; url: string; body?: unknown };

function captureDeps(
    createResponse: unknown = { task_id: "task-1" },
    queryResponse: unknown = { task: { status: "succeeded", content: { url: "https://cdn.example.com/out.mp4" } } },
) {
    const calls: CapturedCall[] = [];
    const deps = {
        response: videoResponseTools,
        transport: {
            post: async (url: string, body: unknown) => {
                calls.push({ method: "post", url, body });
                return createResponse;
            },
            get: async (url: string) => {
                calls.push({ method: "get", url });
                return queryResponse;
            },
        },
    } as unknown as VideoProviderDeps;
    return { calls, deps };
}

const frameImage = { id: "image-1", name: "frame.png", type: "image/png", url: "https://cdn.example.com/frame.png" };

describe("MiniMax H3 upstream payload", () => {
    test("文本生视频把 12 秒、16:9、768P 原样写入中转请求体", async () => {
        const { calls, deps } = captureDeps();
        await createMiniMaxVideoTask(deps, relayConfig({ videoSeconds: "12" }), model, "雨夜城市镜头", [], [], []);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("https://relay.example.com/v2/video_generation");
        const body = calls[0].body as Record<string, unknown>;
        expect(body.model).toBe(modelName);
        expect(body.duration).toBe(12);
        expect(body.ratio).toBe("16:9");
        expect(body.resolution).toBe("768P");
        expect(body.aigc_watermark).toBe(false);
        expect(body.content).toEqual([{ type: "text", text: "雨夜城市镜头" }]);
        expect(Object.keys(body).sort()).toEqual(["aigc_watermark", "content", "duration", "model", "ratio", "resolution"]);
    });

    test("15 秒不会被压回默认 5 秒", async () => {
        const { calls, deps } = captureDeps();
        await createMiniMaxVideoTask(deps, relayConfig({ videoSeconds: "15" }), model, "长镜", [], [], []);
        expect((calls[0].body as Record<string, unknown>).duration).toBe(15);
    });

    test("首帧图生视频把画幅交给上游 adaptive，无法在上游保证 16:9", async () => {
        const { calls, deps } = captureDeps();
        await createMiniMaxVideoTask(deps, relayConfig(), model, "延续首帧", [frameImage], [], []);
        const body = calls[0].body as { ratio: string; content: Array<Record<string, unknown>> };
        expect(body.ratio).toBe("adaptive");
        expect(body.content[1]).toEqual({ type: "image_url", image_url: { url: frameImage.url }, role: "first_frame" });
    });

    test("显式首尾帧节点分别以 first_frame 和 last_frame 角色发送", async () => {
        const { calls, deps } = captureDeps();
        const start = { ...frameImage, id: "start-frame", url: "https://cdn.example.com/start.png" };
        const end = { ...frameImage, id: "end-frame", url: "https://cdn.example.com/end.png" };
        await createMiniMaxVideoTask(deps, relayConfig(), "CHANNEL_000002::minimax_h3_b99_002", "从起始画面转场至结束画面", [start, end], [], [], {
            videoEditOperation: "image_to_video",
            videoStartFrameNodeId: start.id,
            videoEndFrameNodeId: end.id,
        });

        const body = calls[0]?.body as { content: Array<Record<string, unknown>> };
        expect(body.content.slice(1)).toEqual([
            { type: "image_url", image_url: { url: start.url }, role: "first_frame" },
            { type: "image_url", image_url: { url: end.url }, role: "last_frame" },
        ]);
    });

    test("参考图模式保留显式 16:9", async () => {
        const { calls, deps } = captureDeps();
        await createMiniMaxVideoTask(deps, relayConfig(), model, "参考图", [frameImage], [], [], { videoEditOperation: "reference_to_video" });
        const body = calls[0].body as { ratio: string; content: Array<Record<string, unknown>> };
        expect(body.ratio).toBe("16:9");
        expect(body.content[1].role).toBe("reference_image");
    });

    test("能力目录拒绝枚举外时长，不把请求静默改写到 15 秒", () => {
        expect(capability.video).toBeTruthy();
        expect(() => assertVideoCapability(capability.video!, [], [], [], "16")).toThrow("视频时长不在当前模型支持范围内");
        expect(() => assertVideoCapability(capability.video!, [], [], [], "12")).not.toThrow();
    });

    test("创建响应缺少任务 ID 时抛错，而不是伪造任务", async () => {
        const { deps } = captureDeps({});
        await expect(createMiniMaxVideoTask(deps, relayConfig(), model, "prompt", [], [], [])).rejects.toThrow("没有返回任务 ID");
    });

    test("上游报成功但没有视频地址时判定失败", async () => {
        const { deps } = captureDeps({}, { task: { status: "succeeded" } });
        const state = await pollMiniMaxVideoTask(deps, relayConfig(), { id: "task-1", provider: "minimax", model }, {});
        expect(state).toEqual({ status: "failed", error: "MiniMax 视频任务已完成但没有返回视频地址" });
    });

    test("查询地址带回任务 ID，便于桥超时后按原任务对账", async () => {
        const { calls, deps } = captureDeps({}, { task: { status: "processing" } });
        const state = await pollMiniMaxVideoTask(deps, relayConfig(), { id: "task-abc", provider: "minimax", model }, {});
        expect(state).toEqual({ status: "pending" });
        expect(calls[0].url).toBe("https://relay.example.com/v2/query/video_generation/task-abc");
    });
});
