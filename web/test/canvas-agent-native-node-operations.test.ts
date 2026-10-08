import { describe, expect, test } from "bun:test";
import "../src/lib/canvas/node-registry/definitions";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { assertNativeNodeMetadataAllowed, createCanvasAgentNativeNodeOperations } from "../src/pages/canvas/canvas-agent-native-node-operations";

const center = { x: 12, y: 34 };

describe("canvas Agent native node creation", () => {
    test("rejects an explicit unlicensed tldraw drawing before native creation", () => {
        expect(() => assertNativeNodeMetadataAllowed(CanvasNodeType.Drawing, { drawingEngine: "tldraw" })).toThrow("不能创建 tldraw 绘图节点");
        expect(() => assertNativeNodeMetadataAllowed(CanvasNodeType.Drawing, { drawingEngine: "tldraw" }, "configured-key", "tldraw")).not.toThrow();
    });

    test("allows default or explicit Excalidraw drawing metadata", () => {
        expect(() => assertNativeNodeMetadataAllowed(CanvasNodeType.Drawing, undefined)).not.toThrow();
        expect(() => assertNativeNodeMetadataAllowed(CanvasNodeType.Drawing, { drawingEngine: "excalidraw" })).not.toThrow();
    });
    test("rejects a licensed engine that differs from the engine the native creator will persist", () => {
        expect(() => assertNativeNodeMetadataAllowed(CanvasNodeType.Drawing, { drawingEngine: "tldraw" }, "configured-key", "excalidraw"))
            .toThrow("与画布原生默认引擎 excalidraw 不一致");
        expect(() => assertNativeNodeMetadataAllowed(CanvasNodeType.Drawing, { drawingEngine: "tldraw" }, "configured-key", "tldraw")).not.toThrow();
    });
    test("uses the native creator and returns a cloned node snapshot", () => {
        const nodes: CanvasNodeData[] = [];
        const operations = createCanvasAgentNativeNodeOperations({
            nodesRef: { current: nodes },
            getCanvasCenter: () => center,
            createNode: (type, position) => {
                nodes.push({ id: "new-1", type, title: "native", position: position!, width: 20, height: 30, metadata: { content: "native default" } });
            },
        });

        const result = operations.createNode(CanvasNodeType.Markdown);
        expect(result.nodeId).toBe("new-1");
        expect(result.type).toBe(CanvasNodeType.Markdown);
        expect(result.node.metadata?.content).toBe("native default");
        expect(result.node).not.toBe(nodes[0]);
    });

    test("throws when the native creator is gated and creates no node", () => {
        const operations = createCanvasAgentNativeNodeOperations({
            nodesRef: { current: [] },
            getCanvasCenter: () => center,
            createNode: () => undefined,
        });
        expect(() => operations.createNode(CanvasNodeType.Drawing)).toThrow("原生节点创建未成功");
    });

    test("rejects invalid coordinates before invoking the page creator", () => {
        let called = false;
        const operations = createCanvasAgentNativeNodeOperations({
            nodesRef: { current: [] },
            getCanvasCenter: () => center,
            createNode: () => { called = true; },
        });
        expect(() => operations.createNode(CanvasNodeType.Script, { x: Number.NaN, y: 0 })).toThrow("有限坐标");
        expect(called).toBe(false);
    });
});
