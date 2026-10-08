import { describe, expect, test } from "bun:test";

import type { VideoProviderDeps } from "../src/services/api/video-provider-deps";
import { createVideoGenerationsTask, pollVideoGenerationsTask } from "../src/services/api/video-provider-newapi";
import { normalizeVideoAspectRatio } from "../src/services/api/video-validation";
import { videoResponseTools } from "../src/services/api/video-response";

const model = "CHANNEL_NEWAPI::newapi-video-1";

function relayConfig(overrides: Record<string, unknown> = {}) {
    return {
        baseUrl: "https://relay.example.com/v1",
        apiKey: "test-key",
        model,
        videoModel: model,
        videoSeconds: "13",
        size: "16:9",
        vquality: "720p",
        videoGenerateAudio: "false",
        channels: [],
        ...overrides,
    } as never;
}

function captureDeps(createResponse: unknown = { id: "task-1", status: "queued" }) {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const deps = {
        response: videoResponseTools,
        transport: {
            apiUrl: (path: string) => `https://relay.example.com/v1${path}`,
            post: async (url: string, body: unknown) => {
                calls.push({ url, body });
                return createResponse;
            },
            get: async () => ({}),
        },
    } as unknown as VideoProviderDeps;
    return { calls, deps };
}

describe("NewAPI video generations payload", () => {
    test("文本生视频保留显式 13 秒与横屏尺寸，不发送未声明的参数", async () => {
        const { calls, deps } = captureDeps();
        await createVideoGenerationsTask(deps, relayConfig(), model, "雨夜街景", [], [], []);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("https://relay.example.com/v1/video/generations");
        const body = calls[0].body as Record<string, unknown>;
        expect(body.model).toBe("newapi-video-1");
        expect(body.prompt).toBe("雨夜街景");
        expect(body.seconds).toBe("13");
        expect(body.aspect_ratio).toBe("16:9");
        expect(body.resolution).toBe("720p");
        // 该模型未声明原生音频，不得凭空补 generate_audio；没有参考素材就不带 image/video/audio_urls。
        expect(Object.keys(body).sort()).toEqual(["aspect_ratio", "model", "prompt", "resolution", "seconds"]);
    });

    test("画幅映射保留竖屏方向，并拒绝不能映射的像素尺寸", () => {
        expect(normalizeVideoAspectRatio("9:16")).toBe("9:16");
        expect(normalizeVideoAspectRatio("720x1280")).toBe("9:16");
        expect(normalizeVideoAspectRatio("1280x720")).toBe("16:9");
        expect(normalizeVideoAspectRatio("adaptive")).toBeNull();
        expect(normalizeVideoAspectRatio("1000x700")).toBe("10:7");
        expect(normalizeVideoAspectRatio("1824x1024")).toBe("57:32");
    });

    test("自适应画幅不发送比例字段", async () => {
        const { calls, deps } = captureDeps();
        await createVideoGenerationsTask(deps, relayConfig({ size: "adaptive" }), model, "自动画幅", [], [], []);
        expect(calls[0].body).not.toHaveProperty("aspect_ratio");
    });

    test("带参考图时下发 image_urls，参考音频缺参考视频时直接拒绝", async () => {
        const { calls, deps } = captureDeps();
        await createVideoGenerationsTask(deps, relayConfig(), model, "参考图", [{ id: "image-1", name: "a.png", type: "image/png", url: "https://cdn.example.com/a.png" }], [], []);
        expect((calls[0].body as Record<string, unknown>).image_urls).toEqual(["https://cdn.example.com/a.png"]);

        const audioOnly = captureDeps();
        await expect(createVideoGenerationsTask(audioOnly.deps, relayConfig(), model, "只有音频", [], [], [{ id: "audio-1", name: "a.mp3", type: "audio/mpeg", url: "https://cdn.example.com/a.mp3" }]))
            .rejects.toThrow("参考音频必须同时提供至少 1 个参考视频");
    });

    test("显式首尾帧按节点 ID 排序后下发 image_urls", async () => {
        const { calls, deps } = captureDeps();
        await createVideoGenerationsTask(deps, relayConfig(), model, "首尾帧", [
            { id: "end-frame", name: "end.png", type: "image/png", url: "https://cdn.example.com/end.png" },
            { id: "reference", name: "ref.png", type: "image/png", url: "https://cdn.example.com/ref.png" },
            { id: "start-frame", name: "start.png", type: "image/png", url: "https://cdn.example.com/start.png" },
        ], [], [], { videoStartFrameNodeId: "start-frame", videoEndFrameNodeId: "end-frame" });
        expect((calls[0].body as Record<string, unknown>).image_urls).toEqual([
            "https://cdn.example.com/start.png",
            "https://cdn.example.com/end.png",
            "https://cdn.example.com/ref.png",
        ]);
        expect(calls[0].body).not.toHaveProperty("first_frame");
        expect(calls[0].body).not.toHaveProperty("last_frame");
    });

    test("创建响应缺少任务 ID 时抛错，而不是伪造任务", async () => {
        const { deps } = captureDeps({});
        await expect(createVideoGenerationsTask(deps, relayConfig(), model, "prompt", [], [], []))
            .rejects.toThrow("NewAPI Video Generations 没有返回任务 ID");
    });

    test("查询成功但没有视频地址时判定失败", async () => {
        const deps = {
            response: videoResponseTools,
            transport: {
                apiUrl: (path: string) => `https://relay.example.com/v1${path}`,
                get: async () => ({ status: "SUCCEEDED" }),
            },
        } as unknown as VideoProviderDeps;
        const state = await pollVideoGenerationsTask(deps, { id: "task-1", provider: "video-generations", model }, {});
        expect(state).toEqual({ status: "failed", error: "视频任务已完成但没有返回视频地址" });
    });
});
