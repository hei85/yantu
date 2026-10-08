import { describe, expect, test } from "bun:test";
import { stripVideoDialogueSummary, videoDialogueObservation, videoDialogueSummary } from "../src/lib/video-dialogue-observations";

const details = {
    sampleCount: 1,
    matched: true,
    referenceAudio: true,
    imageCount: 1,
    taskId: "task-from-relay",
    resourceId: "resource-from-relay",
    expectedPhrase: "你好，朋友。",
    transcript: "你好朋友",
    reliability: "unverified",
    humanClarity: "unverified",
};
const observed = [{
    feature: "dialogue",
    source: "yingce_h3_asr_audit",
    reason: "适合对白对话（需音频）",
    details,
}];

describe("relay-persisted dialogue observation", () => {
    test("resolves by evidence on a newly assigned channel/model, without fixed IDs", () => {
        expect(videoDialogueSummary(observed, "Provider model note")).toBe("适合对白对话（需音频）");
        expect(videoDialogueObservation(observed)).toEqual(details);
    });

    test("uses a description label when the relay has not returned the observed array", () => {
        const description = "支持图生视频 · 适合对白对话 · 当前仅单次样本";
        const summary = videoDialogueSummary(undefined, description);
        expect(summary).toBe("适合对白对话");
        expect(stripVideoDialogueSummary(description, summary)).toBe("支持图生视频 · 当前仅单次样本");
        expect(videoDialogueSummary(undefined, "不适合对白对话")).toBe("不适合对白对话");
    });

    test("keeps unknown evidence blank and does not invent an observation", () => {
        expect(videoDialogueSummary([], "Provider model note")).toBe("");
        expect(videoDialogueObservation([])).toBeUndefined();
    });
});
