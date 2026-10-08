import { describe, expect, test } from "bun:test";
import { normalizeFamily, videoModelMatchesFamily } from "../src/lib/video-model-family";

describe("video model family constraint", () => {
    test("normalizes a user-requested MiniMax H3 family", () => {
        expect(normalizeFamily("MiniMax H3 系列")).toBe("minimax_h3");
        expect(normalizeFamily("H3")).toBe("minimax_h3");
    });

    test("accepts H3 variants from a configured channel", () => {
        expect(videoModelMatchesFamily("CHANNEL_000003::minimax_h3_z0902", "MiniMax H3")).toBe(true);
        expect(videoModelMatchesFamily("CHANNEL_000003::minimax_h3_image_audio_to_video_v2", "H3")).toBe(true);
    });

    test("rejects another family and similarly prefixed model names", () => {
        expect(videoModelMatchesFamily("CHANNEL_000003::doubao-seedance-2-0-fast-260128", "MiniMax H3")).toBe(false);
        expect(videoModelMatchesFamily("CHANNEL_000003::minimax_h30", "MiniMax H3")).toBe(false);
    });
});
