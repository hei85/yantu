import assert from "node:assert/strict";
import { test } from "node:test";

import { applyCanvasOperations, canvasPreconditionConflict, verifyCanvasOperations, type CanvasSnapshot } from "../src/lib/canvas/canvas-operation-contract";
import { hashCanvasSnapshotForStoryboardConfirmation } from "../src/lib/canvas/canvas-agent-precondition";

test("storyboard quote confirmation ignores only submission-owned transient fields", () => {
    const before: CanvasSnapshot = {
        projectId: "canvas-1", title: "fixture",
        nodes: [
            { id: "script-1", type: "script", title: "分镜表", position: { x: 0, y: 0 }, width: 400, height: 300, updatedAt: "old", metadata: { storyboard: { rows: [{ id: "row-1", plotDescription: "原始镜头" }] } } },
            { id: "text-1", type: "text", title: "Text", position: { x: 500, y: 0 }, width: 300, height: 200, metadata: { content: "keep" } },
        ],
        connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 },
    };
    const script = before.nodes[0];
    const baselineHash = hashCanvasSnapshotForStoryboardConfirmation(before, script.id, script);
    const selfUpdated: CanvasSnapshot = {
        ...before,
        nodes: before.nodes.map((node) => node.id !== script.id ? node : ({
            ...node, updatedAt: "new", metadata: { ...node.metadata, status: "loading", taskStage: "正在创建任务", taskProgress: 0, composerContent: "prompt", taskClientOperationId: "op-1", skillIds: ["skill-1"] },
        })),
    };
    assert.equal(hashCanvasSnapshotForStoryboardConfirmation(selfUpdated, script.id, script), baselineHash);
    const changedRows = structuredClone(selfUpdated);
    changedRows.nodes[0].metadata!.storyboard!.rows![0].plotDescription = "外部改动";
    assert.notEqual(hashCanvasSnapshotForStoryboardConfirmation(changedRows, script.id, script), baselineHash);
    const changedOtherNode = structuredClone(selfUpdated);
    changedOtherNode.nodes[1].metadata!.content = "external";
    assert.notEqual(hashCanvasSnapshotForStoryboardConfirmation(changedOtherNode, script.id, script), baselineHash);
    const changedConnections = structuredClone(selfUpdated);
    changedConnections.connections.push({ id: "edge-1", fromNodeId: "script-1", toNodeId: "text-1" });
    assert.notEqual(hashCanvasSnapshotForStoryboardConfirmation(changedConnections, script.id, script), baselineHash);
});

test("canvas preconditions tolerate revision sync drift only when the state hash still matches", () => {
    assert.equal(canvasPreconditionConflict(4, "same-state", 3, "same-state"), null);
    assert.equal(canvasPreconditionConflict(4, undefined, 3, "same-state"), "revision");
    assert.equal(canvasPreconditionConflict(4, "changed-state", 3, "same-state"), "revision");
    assert.equal(canvasPreconditionConflict(3, "changed-state", 3, "same-state"), "state");
    assert.equal(canvasPreconditionConflict(3, undefined, 3, "same-state"), null);
});

test("canvas operations retain row-scoped storyboard connections through verification", () => {
    const before: CanvasSnapshot = {
        projectId: "canvas-1",
        title: "fixture",
        nodes: [
            { id: "script-1", type: "script", title: "分镜表", position: { x: 0, y: 0 }, width: 400, height: 300, metadata: {} },
            { id: "video-1", type: "video", title: "镜头视频", position: { x: 500, y: 0 }, width: 320, height: 180, metadata: {} },
        ],
        connections: [],
        selectedNodeIds: [],
        viewport: { x: 0, y: 0, k: 1 },
    };
    const ops = [
        { type: "connect_nodes", id: "row-a-edge", fromNodeId: "script-1", toNodeId: "video-1", fromHandleId: "row:row-a", relation: "storyboard-output", storyboardRowId: "row-a" },
        { type: "connect_nodes", id: "row-b-edge", fromNodeId: "script-1", toNodeId: "video-1", fromHandleId: "row:row-b", relation: "storyboard-output", storyboardRowId: "row-b" },
    ] as const;

    const after = applyCanvasOperations(before, [...ops]);
    assert.equal(after.connections.length, 2);
    assert.deepEqual(after.connections.map((edge) => [edge.id, edge.relation, edge.storyboardRowId]).sort(), [
        ["row-a-edge", "storyboard-output", "row-a"],
        ["row-b-edge", "storyboard-output", "row-b"],
    ]);
    assert.equal(verifyCanvasOperations(before, after, [...ops]).ok, true);
});
