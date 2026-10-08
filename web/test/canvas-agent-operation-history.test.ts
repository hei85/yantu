import { describe, expect, test } from "bun:test";

import { hashCanvasSnapshot, type CanvasSnapshot } from "@/lib/canvas/canvas-operation-contract";
import { canvasAgentOperationTrackedFields, createCanvasAgentOperationBatch, hashCanvasAgentOperationSnapshot, redoCanvasAgentOperationHistory, undoCanvasAgentOperationHistory, type CanvasOperationRedoBatch, type CanvasOperationUndoBatch } from "@/pages/canvas/use-canvas-operation-history";
import { CanvasNodeType } from "@/types/canvas";

function snapshot(content: string): CanvasSnapshot {
    return {
        projectId: "canvas-1",
        title: "Test canvas",
        nodes: [{ id: "node-1", type: CanvasNodeType.Text, title: "Text", position: { x: 0, y: 0 }, width: 100, height: 80, metadata: { content } }],
        connections: [],
        selectedNodeIds: [],
        viewport: { x: 0, y: 0, k: 1 },
    };
}

function batch(before: CanvasSnapshot, after: CanvasSnapshot, id: string, trackedFields?: CanvasOperationUndoBatch["trackedFields"]): CanvasOperationUndoBatch {
    return {
        snapshot: before,
        afterSnapshot: after,
        afterStateHash: hashCanvasAgentOperationSnapshot(after, trackedFields),
        trackedFields,
        change: { id, summary: `Change ${id}`, nodeIds: ["node-1"] },
    };
}

function generationFlowSnapshot(composerContent: string, viewport: CanvasSnapshot["viewport"] = { x: 0, y: 0, k: 1 }, selectedNodeIds: string[] = []): CanvasSnapshot {
    return {
        projectId: "canvas-1",
        title: "Test canvas",
        nodes: [
            { id: "node-text", type: CanvasNodeType.Text, title: "文本1", position: { x: 0, y: 0 }, width: 200, height: 100, metadata: { content: "prompt" } },
            { id: "node-video", type: CanvasNodeType.Video, title: "视频1", position: { x: 300, y: 0 }, width: 200, height: 100, metadata: { composerContent } },
        ],
        connections: [{ id: "edge-1", fromNodeId: "node-text", toNodeId: "node-video" }],
        selectedNodeIds,
        viewport,
    };
}

describe("canvas Agent operation undo/redo", () => {
    test("records verified native MCP before/after snapshots and rejects no-op or cross-canvas results", () => {
        const before = snapshot("before");
        const after = { ...before, nodes: [{ ...before.nodes[0], metadata: { content: "after" } }] };
        const nativeBatch = createCanvasAgentOperationBatch(before, after, "Update text", ["node-1"]);
        expect(nativeBatch?.snapshot).toBe(before);
        expect(nativeBatch?.afterSnapshot).toBe(after);
        expect(undoCanvasAgentOperationHistory(nativeBatch ? [nativeBatch] : [], [], after).status).toBe("applied");
        expect(createCanvasAgentOperationBatch(before, before, "No-op", [])).toBeNull();
        expect(createCanvasAgentOperationBatch(before, { ...after, projectId: "canvas-2" }, "Wrong canvas", ["node-1"])).toBeNull();
    });
    test("undoes then redoes multiple batches in the original order", () => {
        const initial = snapshot("initial");
        const afterA = snapshot("A");
        const afterB = snapshot("B");
        let undo = [batch(initial, afterA, "A"), batch(afterA, afterB, "B")];
        let redo: CanvasOperationRedoBatch[] = [];

        const undoB = undoCanvasAgentOperationHistory(undo, redo, afterB);
        expect(undoB.status).toBe("applied");
        if (undoB.status !== "applied") return;
        expect(undoB.snapshot).toBe(afterA);
        undo = undoB.undoStack;
        redo = undoB.redoStack;

        const undoA = undoCanvasAgentOperationHistory(undo, redo, afterA);
        expect(undoA.status).toBe("applied");
        if (undoA.status !== "applied") return;
        expect(undoA.snapshot).toBe(initial);
        undo = undoA.undoStack;
        redo = undoA.redoStack;

        const redoA = redoCanvasAgentOperationHistory(undo, redo, initial);
        expect(redoA.status).toBe("applied");
        if (redoA.status !== "applied") return;
        expect(redoA.snapshot).toBe(afterA);
        undo = redoA.undoStack;
        redo = redoA.redoStack;

        const redoB = redoCanvasAgentOperationHistory(undo, redo, afterA);
        expect(redoB.status).toBe("applied");
        if (redoB.status !== "applied") return;
        expect(redoB.snapshot).toBe(afterB);
    });

    test("rejects redo after any intervening snapshot change and clears both directions", () => {
        const before = snapshot("before");
        const after = snapshot("agent edit");
        const interveningUserEdit = snapshot("manual edit");
        const undone = undoCanvasAgentOperationHistory([batch(before, after, "change")], [], after);
        expect(undone.status).toBe("applied");
        if (undone.status !== "applied") return;

        const stale = redoCanvasAgentOperationHistory(undone.undoStack, undone.redoStack, interveningUserEdit);
        expect(stale.status).toBe("stale");
        expect(stale.undoStack).toEqual([]);
        expect(stale.redoStack).toEqual([]);
    });

    test("keeps undo across connection-driven composer reference normalization", () => {
        const before = snapshot("before");
        const created = generationFlowSnapshot("@[node:node-text]");
        const normalized = generationFlowSnapshot("@文本1", { x: -1504.1, y: -274.9, k: 0.6368 }, ["node-video"]);
        const trackedFields = { viewport: false, selection: false };
        const history = [batch(before, created, "generation-flow", trackedFields)];

        expect(hashCanvasAgentOperationSnapshot(created, trackedFields)).toBe(hashCanvasAgentOperationSnapshot(normalized, trackedFields));
        expect(hashCanvasSnapshot(created)).not.toBe(hashCanvasSnapshot(normalized));
        const undone = undoCanvasAgentOperationHistory(history, [], normalized);
        expect(undone.status).toBe("applied");
        if (undone.status === "applied") {
            expect(undone.snapshot.viewport).toEqual(normalized.viewport);
            expect(undone.snapshot.selectedNodeIds).toEqual([]);
            expect(undone.snapshot.nodes).toEqual(before.nodes);
            const redone = redoCanvasAgentOperationHistory(undone.undoStack, undone.redoStack, undone.snapshot);
            expect(redone.status).toBe("applied");
            if (redone.status === "applied") {
                expect(redone.snapshot.viewport).toEqual(normalized.viewport);
                expect(redone.snapshot.selectedNodeIds).toEqual([]);
                expect(redone.snapshot.nodes).toEqual(created.nodes);
            }
        }
    });

    test("still rejects undo after a real prompt edit to a referenced generation node", () => {
        const before = snapshot("before");
        const created = generationFlowSnapshot("@[node:node-text]");
        const userEdited = generationFlowSnapshot("@文本1 altered by user");
        const stale = undoCanvasAgentOperationHistory([batch(before, created, "generation-flow", { viewport: false, selection: false })], [], userEdited);

        expect(stale.status).toBe("stale");
        expect(stale.undoStack).toEqual([]);
        expect(stale.redoStack).toEqual([]);
    });

    test("keeps explicit viewport and selection operations strictly undoable", () => {
        const initial = snapshot("content");
        const viewportAfter = { ...initial, viewport: { x: -400, y: -120, k: 0.8 } };
        const viewBatch = batch(initial, viewportAfter, "set-viewport", { viewport: true, selection: false });
        const undoView = undoCanvasAgentOperationHistory([viewBatch], [], viewportAfter);
        expect(undoView.status).toBe("applied");
        if (undoView.status === "applied") expect(undoView.snapshot.viewport).toEqual(initial.viewport);

        const selectedAfter = { ...initial, selectedNodeIds: ["node-1"] };
        const selectionBatch = batch(initial, selectedAfter, "select-nodes", { viewport: false, selection: true });
        const undoSelection = undoCanvasAgentOperationHistory([selectionBatch], [], selectedAfter);
        expect(undoSelection.status).toBe("applied");
        if (undoSelection.status === "applied") expect(undoSelection.snapshot.selectedNodeIds).toEqual(initial.selectedNodeIds);

        const movedViewport = { ...viewportAfter, viewport: { x: -420, y: -120, k: 0.8 } };
        expect(undoCanvasAgentOperationHistory([viewBatch], [], movedViewport).status).toBe("stale");
    });

    test("distinguishes automatic focus of newly created nodes from explicit selection", () => {
        const createdFlow = canvasAgentOperationTrackedFields([
            { type: "add_node", id: "new-video", nodeType: CanvasNodeType.Video },
            { type: "select_nodes", ids: ["new-video"] },
        ], new Set(["new-video"]));
        expect(createdFlow).toEqual({ viewport: false, selection: false });

        const explicitSelection = canvasAgentOperationTrackedFields([
            { type: "select_nodes", ids: ["existing-note"] },
        ], new Set());
        expect(explicitSelection).toEqual({ viewport: false, selection: true });
    });

    test("undo after inspecting a newly created node keeps only still-existing selected nodes", () => {
        const before = snapshot("original Note");
        const flow = generationFlowSnapshot("@[node:node-text]");
        const created: CanvasSnapshot = {
            ...before,
            nodes: [...before.nodes, ...flow.nodes],
            connections: flow.connections,
            selectedNodeIds: ["node-text", "node-video"],
        };
        const afterInspectingVideo: CanvasSnapshot = {
            ...created,
            nodes: created.nodes.map((node) => node.id === "node-video" ? { ...node, metadata: { ...node.metadata, composerContent: "@文本1" } } : node),
            selectedNodeIds: ["node-video"],
            viewport: { x: -1504.1, y: -274.9, k: 0.6368 },
        };
        const fields = canvasAgentOperationTrackedFields([
            { type: "add_node", id: "node-text", nodeType: CanvasNodeType.Text },
            { type: "add_node", id: "node-video", nodeType: CanvasNodeType.Video },
            { type: "select_nodes", ids: ["node-video"] },
        ], new Set(["node-text", "node-video"]));
        const undone = undoCanvasAgentOperationHistory([batch(before, created, "create-flow", fields)], [], afterInspectingVideo);

        expect(fields.selection).toBe(false);
        expect(undone.status).toBe("applied");
        if (undone.status === "applied") {
            expect(undone.snapshot.nodes.map((node) => node.id)).toEqual(["node-1"]);
            expect(undone.snapshot.selectedNodeIds).toEqual([]);
            expect(undone.snapshot.viewport).toEqual(afterInspectingVideo.viewport);
        }
    });

    test("undoing added nodes preserves selection of surviving nodes and drops removed nodes", () => {
        const before = snapshot("original Note");
        const flow = generationFlowSnapshot("@[node:node-text]");
        const created: CanvasSnapshot = {
            ...before,
            nodes: [...before.nodes, ...flow.nodes],
            connections: flow.connections,
            selectedNodeIds: ["node-text", "node-video"],
        };
        const afterFit: CanvasSnapshot = {
            ...created,
            nodes: created.nodes.map((node) => node.id === "node-video" ? { ...node, metadata: { ...node.metadata, composerContent: "@文本1" } } : node),
            selectedNodeIds: ["node-1", "node-text", "node-video"],
            viewport: { x: -1504.1, y: -274.9, k: 0.6368 },
        };
        const fields = { viewport: false, selection: false };
        const undone = undoCanvasAgentOperationHistory([batch(before, created, "create-flow", fields)], [], afterFit);

        expect(undone.status).toBe("applied");
        if (undone.status === "applied") {
            expect(undone.snapshot.nodes.map((node) => node.id)).toEqual(["node-1"]);
            expect(undone.snapshot.selectedNodeIds).toEqual(["node-1"]);
            expect(undone.snapshot.viewport).toEqual(afterFit.viewport);
        }
    });
});
