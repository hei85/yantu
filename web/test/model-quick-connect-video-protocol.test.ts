import { describe, expect, test } from "bun:test";

import { detectVideoProtocol } from "../src/pages/settings/model-quick-connect-pane";

describe("quick-connect video endpoint detection", () => {
    test("recognizes only complete supported endpoint paths", () => {
        expect(detectVideoProtocol("https://relay.example/v1/videos")).toBe("newapi");
        expect(detectVideoProtocol("https://relay.example/v1/video/generations")).toBe("newapi-channel-2");
        expect(detectVideoProtocol("https://relay.example/v1")).toBeUndefined();
        expect(detectVideoProtocol("https://relay.example/v1/videos/generations")).toBeUndefined();
    });
});
