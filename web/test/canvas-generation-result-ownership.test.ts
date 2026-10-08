import { describe, expect, test } from "bun:test";

import { canBindProductionTaskSubmission, generationTaskOwnsNode } from "@/lib/canvas/canvas-generation-result-ownership";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function imageNode(metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return { id: "opening-frame", type: CanvasNodeType.Image, title: "首帧", position: { x: 0, y: 0 }, width: 320, height: 180, metadata };
}

describe("generation result ownership", () => {
    test("a historical task cannot overwrite a picture owned by a newer task", () => {
        expect(generationTaskOwnsNode(imageNode({ taskId: "new-task", content: "new.png", storageKey: "resource:new" }), "old-task")).toBe(false);
    });

    test("manual media adoption is protected even after the task binding is cleared", () => {
        expect(generationTaskOwnsNode(imageNode({ content: "adopted.png", storageKey: "resource:adopted" }), "old-task")).toBe(false);
        expect(generationTaskOwnsNode(imageNode({ assetId: "adopted-asset" }), "old-task")).toBe(false);
    });

    test("the active task can finish replacing the previous visible result", () => {
        expect(generationTaskOwnsNode(imageNode({ taskId: "active-task", content: "previous.png", storageKey: "resource:previous" }), "active-task")).toBe(true);
    });

    test("an empty unbound placeholder can still recover its result", () => {
        expect(generationTaskOwnsNode(imageNode(), "recovered-task")).toBe(true);
    });

    test("replaying an old submission cannot rebind an adopted or newer picture", () => {
        expect(canBindProductionTaskSubmission(imageNode({ taskId: "new-task" }), "old-task", true)).toBe(false);
        expect(canBindProductionTaskSubmission(imageNode({ storageKey: "resource:adopted" }), "old-task", true)).toBe(false);
        expect(canBindProductionTaskSubmission(imageNode({ taskId: "active-task" }), "active-task", true)).toBe(true);
    });

    test("a newly submitted generation intentionally replaces the task binding", () => {
        expect(canBindProductionTaskSubmission(imageNode({ taskId: "old-task", content: "previous.png" }), "new-task", false)).toBe(true);
    });
});
