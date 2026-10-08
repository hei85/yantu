import { describe, expect, test } from "bun:test";

import { generationFlowOps } from "../src/canvas-session";

describe("generation flow guard", () => {
    test("媒体生成缺少提示词时直接报错，而不是静默失败", () => {
        expect(() => generationFlowOps({ mode: "video" }, null)).toThrow(/缺少提示词/);
        expect(() => generationFlowOps({ mode: "image", prompt: "   " }, null)).toThrow(/缺少提示词/);
    });

    test("有提示词时正常生成节点操作（文本节点 + 目标节点 + 连线）", () => {
        const ops = generationFlowOps({ mode: "video", prompt: "camera slowly pushes in", autoRun: true, clientOperationId: "test-op-0001" }, null) as Array<Record<string, unknown>>;
        const types = ops.map((op) => op.type);
        expect(types).toContain("add_node");
        expect(types).toContain("connect_nodes");
        expect(types).toContain("run_generation");
        expect(ops.filter((op) => op.type === "add_node")).toHaveLength(2);
    });

    test("文本生成（text 模式）允许空提示词", () => {
        const ops = generationFlowOps({ mode: "text" }, null) as Array<Record<string, unknown>>;
        expect(ops.some((op) => op.type === "add_node")).toBe(true);
    });

    test("文本生成用不同的稳定 ID 区分提示词节点和生成目标节点", () => {
        const input = { mode: "text", prompt: "请只回复：你好朋友。", autoRun: true, clientOperationId: "mcp-functional-text-test-20260930-01" };
        const build = () => generationFlowOps(input, null) as Array<Record<string, unknown>>;
        const ops = build();
        const addNodes = ops.filter((op) => op.type === "add_node");
        const promptNode = addNodes.find((op) => op.nodeType === "text");
        const outputNode = addNodes.find((op) => op.nodeType === "text" && op.id !== promptNode?.id);
        const connect = ops.find((op) => op.type === "connect_nodes");
        const run = ops.find((op) => op.type === "run_generation");

        expect(addNodes).toHaveLength(2);
        expect(promptNode?.id).toMatch(/^text-[a-f0-9]{16}$/);
        expect(outputNode?.id).toMatch(/^text-output-[a-f0-9]{16}$/);
        expect(new Set(addNodes.map((op) => op.id)).size).toBe(2);
        expect(connect).toMatchObject({ fromNodeId: promptNode?.id, toNodeId: outputNode?.id });
        expect(run).toMatchObject({ nodeId: outputNode?.id, clientOperationId: input.clientOperationId });
        expect(build().filter((op) => op.type === "add_node").map((op) => op.id)).toEqual(addNodes.map((op) => op.id));
    });
});
