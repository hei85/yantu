import { describe, expect, test } from "bun:test";

import { preflightBatchTableRows } from "../src/pages/canvas/canvas-agent-batch-generation-preflight";
import { CanvasNodeType, type CanvasBatchTableData, type CanvasNodeData } from "../src/types/canvas";

const image = (id: string, metadata: CanvasNodeData["metadata"] = { content: `asset:${id}` }) => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata }) as CanvasNodeData;
const table: CanvasBatchTableData = { operation: "creative", concurrency: 2, rows: [
    { id: "ready", enabled: true, inputNodeIds: ["ref"], prompt: "make it" },
    { id: "no-image", enabled: true, inputNodeIds: [], prompt: "make it" },
    { id: "no-prompt", enabled: true, inputNodeIds: ["ref"], prompt: "" },
    { id: "running", enabled: true, inputNodeIds: ["ref"], prompt: "again", outputNodeId: "out" },
] };

describe("batch table generation preflight", () => {
    test("requires explicit unique row IDs", () => {
        expect(() => preflightBatchTableRows({ table, nodes: [image("ref")], rowIds: [], modelReady: true })).toThrow("明确批量行 ID");
        expect(() => preflightBatchTableRows({ table, nodes: [image("ref")], rowIds: ["ready", "ready"], modelReady: true })).toThrow("明确批量行 ID");
    });

    test("marks missing references, missing prompt, and active row precisely", () => {
        const results = preflightBatchTableRows({ table, nodes: [image("ref"), image("out", { taskId: "task-1" })], rowIds: ["ready", "no-image", "no-prompt", "running"], activeNodeIds: ["out"], modelReady: true });
        expect(results.map((row) => row.status)).toEqual(["ready", "blocked", "blocked", "running"]);
        expect(results[1]?.reason).toBe("缺少参考图");
        expect(results[2]?.reason).toBe("缺少生成提示词");
        expect(results[3]).toMatchObject({ nodeId: "out", taskId: "task-1", reason: "已有任务正在处理" });
    });

    test("blocks a row when an input is not a persisted image", () => {
        const results = preflightBatchTableRows({ table, nodes: [{ ...image("ref"), metadata: {} }], rowIds: ["ready"], modelReady: true });
        expect(results[0]).toMatchObject({ status: "blocked", reason: "缺少参考图" });
    });
});
