import { expect, test } from "bun:test";
import { measuredVideoResolution, submittedVideoSettingsMetadata } from "@/lib/canvas/canvas-video-task-settings";

test("keeps the submitted resolution, ratio and seconds separate from global defaults", () => {
    expect(submittedVideoSettingsMetadata(JSON.stringify({ mode: "video", config: { vquality: "480p", size: "16:9", videoSeconds: 3, apiKey: "never-copy" } })))
        .toEqual({ vquality: "480p", size: "16:9", seconds: "3" });
});
test("infers real output resolution for landscape and portrait, without guessing missing sizes", () => {
    expect(measuredVideoResolution(864, 480)).toBe("480p");
    expect(measuredVideoResolution(480, 864)).toBe("480p");
    expect(measuredVideoResolution(1366, 768)).toBe("768p");
    expect(measuredVideoResolution(undefined, 480)).toBeUndefined();
    expect(measuredVideoResolution(1280, 713)).toBeUndefined();
});
test("does not fabricate settings from compacted terminal inputs or other media", () => {
    expect(submittedVideoSettingsMetadata('{"mode":"video","metadata":{"nodeId":"node"}}')).toEqual({});
    expect(submittedVideoSettingsMetadata('{"mode":"image","config":{"size":"1:1"}}')).toEqual({});
    expect(submittedVideoSettingsMetadata('broken')).toEqual({});
});
