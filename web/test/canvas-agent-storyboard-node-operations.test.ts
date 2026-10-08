import { describe, expect, test } from "bun:test";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { createStoryboardRow } from "../src/lib/canvas/canvas-project-domain";
import { createCanvasAgentStoryboardNodeOperations } from "../src/pages/canvas/canvas-agent-storyboard-node-operations";

function createRefs() {
    const row = createStoryboardRow(1, { id: "row-1", plotDescription: "人物走进房间" });
    const script: CanvasNodeData = {
        id: "script", type: CanvasNodeType.Script, title: "脚本", position: { x: 0, y: 0 }, width: 600, height: 300,
        metadata: { storyboard: { rows: [row], visibleColumns: [], referenceNodeIds: [] } },
    };
    return { nodesRef: { current: [script] }, connectionsRef: { current: [] as CanvasNodeData[] } };
}

describe("canvas Agent storyboard media nodes", () => {
    test("calls native image-node creation and returns row mapping plus snapshots", () => {
        const { nodesRef, connectionsRef } = createRefs();
        const operations = createCanvasAgentStoryboardNodeOperations({
            nodesRef,
            connectionsRef: connectionsRef as never,
            createScriptImageNodes: (nodeId, rowIds) => {
                const script = nodesRef.current.find((node) => node.id === nodeId)!;
                const image: CanvasNodeData = { id: "image-1", type: CanvasNodeType.Image, title: "镜头图", position: { x: 10, y: 10 }, width: 100, height: 100 };
                nodesRef.current = [
                    ...nodesRef.current.map((node) => node.id === nodeId ? { ...script, metadata: { ...script.metadata, storyboard: { ...script.metadata?.storyboard, rows: script.metadata?.storyboard?.rows.map((row) => rowIds?.includes(row.id) ? { ...row, imageNodeId: image.id } : row) } } } : node),
                    image,
                ];
            },
            createScriptVideoNodes: () => { throw new Error("unexpected video path"); },
        });

        const result = operations.createImageNodes({ nodeId: "script", rowIds: ["row-1"] });
        expect(result.items[0].rowId).toBe("row-1");
        expect(result.nodeIds).toEqual(["image-1"]);
        expect(result.items[0].node.type).toBe(CanvasNodeType.Image);
    });

    test("rejects unknown rows before invoking native creation", () => {
        const { nodesRef, connectionsRef } = createRefs();
        let called = false;
        const operations = createCanvasAgentStoryboardNodeOperations({
            nodesRef,
            connectionsRef: connectionsRef as never,
            createScriptImageNodes: () => { called = true; },
            createScriptVideoNodes: () => { called = true; },
        });
        expect(() => operations.createVideoNodes({ nodeId: "script", rowIds: ["absent"] })).toThrow("分镜行不存在");
        expect(called).toBe(false);
    });
});
