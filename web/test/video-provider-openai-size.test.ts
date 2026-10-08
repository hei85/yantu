import { describe, expect, test } from "bun:test";

import { createOpenAIVideoTask } from "../src/services/api/video-provider-openai";
import type { VideoProviderDeps } from "../src/services/api/video-provider-deps";
import { videoResponseTools } from "../src/services/api/video-response";

function setup(baseUrl: string, model = "minimax_h3_video", size = "1280x720") {
    let body: FormData | undefined;
    const config = {
        baseUrl,
        apiKey: "test-key",
        interfaceType: "newapi",
        videoSeconds: "6",
        size,
        vquality: "720p",
        channels: [{ id: "channel", baseUrl, models: [model], modelCosts: [{ model, protocol: "newapi" }] }],
    } as never;
    const deps = {
        response: videoResponseTools,
        transport: {
            apiUrl: (path: string) => `${baseUrl}${path}`,
            postForm: async (_url: string, value: FormData) => { body = value; return { id: "task-1" }; },
        },
    } as unknown as VideoProviderDeps;
    return { config, deps, getBody: () => body };
}

describe("OpenAI-compatible video size fields", () => {
    test("maps H3 pixel size to aspect_ratio only on the verified relay", async () => {
        const { config, deps, getBody } = setup("https://zh.heihan.dpdns.org/v1");
        await createOpenAIVideoTask(deps, config, "channel::minimax_h3_video", "test", []);
        expect(getBody()?.get("size")).toBe("1280x720");
        expect(getBody()?.get("aspect_ratio")).toBe("16:9");
    });

    test("does not add H3-only aspect_ratio for ordinary relays or adaptive size", async () => {
        const ordinary = setup("https://relay.example/v1", "video-model");
        await createOpenAIVideoTask(ordinary.deps, ordinary.config, "channel::video-model", "test", []);
        expect(ordinary.getBody()?.get("size")).toBe("1280x720");
        expect(ordinary.getBody()?.has("aspect_ratio")).toBe(false);

        const adaptive = setup("https://zh.heihan.dpdns.org/v1", "minimax_h3_video", "adaptive");
        await createOpenAIVideoTask(adaptive.deps, adaptive.config, "channel::minimax_h3_video", "test", []);
        expect(adaptive.getBody()?.has("size")).toBe(false);
        expect(adaptive.getBody()?.has("aspect_ratio")).toBe(false);
    });

    test("orders explicitly selected H3 start/end frames before other multipart references", async () => {
        const { config, deps, getBody } = setup("https://zh.heihan.dpdns.org/v1", "minimax_h3_b99_002");
        await createOpenAIVideoTask(deps, config, "channel::minimax_h3_b99_002", "首尾帧", [
            { id: "end-frame", name: "end.png", type: "image/png", dataUrl: "data:image/png;base64,YQ==" },
            { id: "reference", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,Yg==" },
            { id: "start-frame", name: "start.png", type: "image/png", dataUrl: "data:image/png;base64,Yw==" },
        ], { videoStartFrameNodeId: "start-frame", videoEndFrameNodeId: "end-frame" });
        const files = getBody()?.getAll("input_reference[]") as File[];
        expect(files.map((file) => file.name)).toEqual(["start.png", "end.png", "ref.png"]);
    });
});
