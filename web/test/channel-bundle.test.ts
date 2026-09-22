import { describe, expect, test } from "bun:test";

import { buildChannelBundle, channelBundleFileName, parseChannelBundle, sharedHeaders, type ChannelBundleChannel } from "../src/lib/channel-bundle";

const channel: ChannelBundleChannel = {
    name: "中转站",
    baseUrl: "https://example.com/v1",
    apiFormat: "openai",
    headers: [
        { name: "X-Route", value: "gpu-1" },
        { name: "Authorization", value: "Bearer sk-should-not-leak" },
        { name: "X-Api-Key", value: "sk-should-not-leak" },
        { name: "  ", value: "dropped" },
    ],
    models: [{ modelKey: "minimax_h3_z0902", displayName: "H3 文生视频", capability: "video", billingMode: "per_second" }],
};

describe("channel bundle export", () => {
    test("share bundle never carries credentials", () => {
        const serialized = JSON.stringify(buildChannelBundle([{ ...channel, apiKey: "sk-channel-key", secretKey: "ak-channel-secret" } as unknown as ChannelBundleChannel]));
        expect(serialized).not.toContain("sk-channel-key");
        expect(serialized).not.toContain("ak-channel-secret");
        expect(serialized).not.toContain("sk-should-not-leak");
        expect(serialized).not.toContain("Authorization");
        expect(serialized).not.toContain("X-Api-Key");
    });

    test("routing headers survive export", () => {
        expect(sharedHeaders(channel.headers || [])).toEqual([{ name: "X-Route", value: "gpu-1" }]);
        expect(buildChannelBundle([channel]).channels[0]?.headers).toEqual([{ name: "X-Route", value: "gpu-1" }]);
    });

    test("bundle keeps connection and model definitions for the recipient", () => {
        const bundle = buildChannelBundle([channel]);
        expect(bundle.format).toBe("yingce.channel-bundle");
        expect(bundle.version).toBe(1);
        expect(bundle.channels[0]?.baseUrl).toBe("https://example.com/v1");
        expect(bundle.channels[0]?.models).toEqual([{ modelKey: "minimax_h3_z0902", displayName: "H3 文生视频", capability: "video", billingMode: "per_second" }]);
    });

    test("file name is a dated json file", () => {
        expect(channelBundleFileName()).toMatch(/^衍图渠道-\d{4}-\d{2}-\d{2}\.json$/u);
    });
});

describe("channel bundle import", () => {
    test("round trips an exported bundle", () => {
        const parsed = parseChannelBundle(JSON.stringify(buildChannelBundle([channel])));
        expect(parsed.channels).toHaveLength(1);
        expect(parsed.channels[0]?.name).toBe("中转站");
        expect(parsed.channels[0]?.models[0]?.capability).toBe("video");
    });

    test("rejects unrelated json and empty bundles", () => {
        expect(() => parseChannelBundle("not json")).toThrow("不是有效的 JSON 文件");
        expect(() => parseChannelBundle(JSON.stringify({ hello: "world" }))).toThrow("这不是衍图渠道分享包");
        expect(() => parseChannelBundle(JSON.stringify({ format: "yingce.channel-bundle", channels: [] }))).toThrow("分享包里没有渠道");
    });

    test("drops entries without a base url and unknown capabilities", () => {
        const parsed = parseChannelBundle(JSON.stringify({
            format: "yingce.channel-bundle",
            channels: [
                { name: "坏渠道", baseUrl: "" },
                { name: "好渠道", baseUrl: "https://example.com/v1", models: [{ modelKey: "a" }, { displayName: "缺少模型 ID" }] },
            ],
        }));
        expect(parsed.channels).toHaveLength(1);
        expect(parsed.channels[0]?.models).toEqual([{ modelKey: "a", providerModelKey: undefined, displayName: undefined, description: undefined, icon: undefined, capability: "", protocol: undefined, billingMode: undefined, capabilityConfig: undefined }]);
    });
});
