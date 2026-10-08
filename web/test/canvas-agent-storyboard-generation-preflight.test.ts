import { describe, expect, test } from "bun:test";

import { preflightStoryboardMediaRows } from "../src/pages/canvas/canvas-agent-storyboard-generation-preflight";
import { CanvasNodeType, type CanvasNodeData, type StoryboardRow } from "../src/types/canvas";

const row = (patch: Partial<StoryboardRow> = {}) => ({
    id: "row-a", shotNumber: 1, durationSeconds: 4, plotDescription: "wide shot", dialogue: "", characters: [], narrativeIntent: "", viewerPOV: "", performanceBlocking: "", shotSize: "wide", emotion: "calm", lightingAndAtmosphere: "day", audioEffects: "", camera: "static", motion: "", timeBeats: "", imageGenerationPrompt: "image prompt", videoMotionPrompt: "video prompt", mustHave: [], optionalDetails: [], continuityOut: "", negativePrompt: "", assetBindings: [], ...patch,
}) as StoryboardRow;

const imageNode = (metadata: CanvasNodeData["metadata"] = {}) => ({ id: "image-a", type: CanvasNodeType.Image, title: "image", position: { x: 0, y: 0 }, width: 100, height: 100, metadata } as CanvasNodeData);

describe("storyboard media generation preflight", () => {
    test("requires explicit unique row IDs and an existing requested row", () => {
        expect(() => preflightStoryboardMediaRows({ rows: [row()], nodes: [], rowIds: [], kind: "image", modelReady: true, idempotentSubmissionAvailable: false })).toThrow("明确分镜行 ID");
        expect(() => preflightStoryboardMediaRows({ rows: [row()], nodes: [], rowIds: ["missing"], kind: "image", modelReady: true, idempotentSubmissionAvailable: false })).toThrow("分镜行不存在");
    });

    test("reports existing outputs and active tasks without resubmitting", () => {
        const completed = imageNode({ content: "asset" });
        const running = { ...imageNode({ status: "loading", taskId: "task-1" }), id: "image-b" };
        const results = preflightStoryboardMediaRows({
            rows: [row({ imageNodeId: completed.id }), row({ id: "row-b", imageNodeId: running.id })],
            nodes: [completed, running], rowIds: ["row-a", "row-b"], kind: "image", modelReady: true, idempotentSubmissionAvailable: false,
        });
        expect(results.map((item) => item.status)).toEqual(["completed", "running"]);
        expect(results[1]?.taskId).toBe("task-1");
    });

    test("blocks chargeable submissions while per-row idempotency is unavailable", () => {
        const results = preflightStoryboardMediaRows({ rows: [row({ imageNodeId: "image-a" })], nodes: [imageNode()], rowIds: ["row-a"], kind: "image", modelReady: true, idempotentSubmissionAvailable: false });
        expect(results[0]).toMatchObject({ status: "blocked", nodeId: "image-a", reason: expect.stringContaining("稳定 clientOperationId") });
    });
});
