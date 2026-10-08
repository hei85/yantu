import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node 原生 TypeScript 测试运行器需要保留扩展名。
import { storyboardVideoFrameNodeIds, storyboardVideoOperation, storyboardVideoPrompt } from "./canvas-storyboard-materializer.ts";
// @ts-expect-error -- Node 原生 TypeScript 测试运行器需要保留扩展名。
import { CanvasNodeType, type CanvasNodeData, type StoryboardRow } from "../../types/canvas.ts";

const row = (overrides: Partial<StoryboardRow> = {}): StoryboardRow => ({
    id: "shot-1",
    shotNumber: 1,
    durationSeconds: 6,
    plotDescription: "短剧情描述",
    videoMotionPrompt: "完整的视频运动与镜头提示词",
    dialogue: "",
    characters: [],
    narrativeIntent: "",
    viewerPOV: "",
    performanceBlocking: "",
    shotSize: "",
    emotion: "",
    lightingAndAtmosphere: "",
    audioEffects: "",
    camera: "",
    motion: "",
    timeBeats: "",
    imageGenerationPrompt: "",
    mustHave: [],
    optionalDetails: [],
    continuityOut: "",
    negativePrompt: "",
    assetBindings: [],
    status: "idle",
    ...overrides,
});

function videoNode(metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return { id: "video-1", type: CanvasNodeType.Video, title: "video", position: { x: 0, y: 0 }, width: 320, height: 180, metadata };
}

test("storyboard video prompt prefers full motion prompt over plot summary", () => {
    assert.equal(storyboardVideoPrompt(row()), "完整的视频运动与镜头提示词");
    assert.equal(storyboardVideoPrompt(row({ videoMotionPrompt: "  ", plotDescription: "回退剧情描述" })), "回退剧情描述");
});

test("storyboard video operation honors row intent and preserves explicit keyframe references", () => {
    const existing = videoNode({ videoEditOperation: "text_to_video", videoStartFrameNodeId: "first-frame", videoEndFrameNodeId: "last-frame" });
    const storyboardRow = row({ videoOperation: "image_to_video", imageNodeId: "row-first-frame" });

    assert.equal(storyboardVideoOperation(storyboardRow, existing), "image_to_video");
    assert.deepEqual(storyboardVideoFrameNodeIds(storyboardRow, existing), ["first-frame", "last-frame", "row-first-frame"]);
});

test("storyboard video builder infers image-to-video when a row already has a first frame", () => {
    const storyboardRow = row({ imageNodeId: "first-frame" });
    assert.equal(storyboardVideoOperation(storyboardRow), "image_to_video");
    assert.deepEqual(storyboardVideoFrameNodeIds(storyboardRow), ["first-frame"]);
});
