import { expect, test } from "bun:test";
import { applyCanvasAgentReferenceOperation } from "@/pages/canvas/canvas-agent-reference-operations";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, type: CanvasNodeType, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 240, height: 160, metadata });

function run(nodes: CanvasNodeData[], connections: CanvasConnection[], operation: Parameters<typeof applyCanvasAgentReferenceOperation>[0]) {
    const refs = { nodesRef: { current: nodes }, connectionsRef: { current: connections } };
    const state = { nodes: [] as CanvasNodeData[], connections: [] as CanvasConnection[] };
    const result = applyCanvasAgentReferenceOperation(operation, refs, { setNodes: (next) => state.nodes = next, setConnections: (next) => state.connections = next });
    expect(state.nodes).toBe(result.nodes);
    expect(state.connections).toBe(result.connections);
    return { ...result, refs };
}

test("add creates a real reference edge and a verifiable composer mention", () => {
    const result = run([node("image", CanvasNodeType.Image, { content: "image-data" }), node("video", CanvasNodeType.Video, { composerContent: "跟随主体" })], [], { operation: "add", targetNodeId: "video", sourceNodeId: "image", connectionId: "edge" });
    expect(result.connections).toEqual([{ id: "edge", fromNodeId: "image", toNodeId: "video" }]);
    expect(result.composerContent).toContain("@[node:image]");
    expect(result.references).toEqual([{ nodeId: "image", label: "图片1", kind: "image" }]);
    expect(result.refs.connectionsRef.current).toBe(result.connections);
});

test("configuration node remains the receiving endpoint when it already receives references", () => {
    const nodes = [node("base", CanvasNodeType.Image, { content: "base-data" }), node("video", CanvasNodeType.Video), node("config", CanvasNodeType.Config), node("extra", CanvasNodeType.Image, { content: "extra-data" })];
    const connections = [{ id: "main", fromNodeId: "video", toNodeId: "config" }, { id: "base-edge", fromNodeId: "base", toNodeId: "config" }];
    const result = run(nodes, connections, { operation: "add", targetNodeId: "video", sourceNodeId: "extra", connectionId: "extra-edge" });
    expect(result.connections.at(-1)).toMatchObject({ fromNodeId: "extra", toNodeId: "config" });
    expect(result.references.map((reference) => reference.nodeId)).toEqual(["base", "extra"]);
});

test("remove drops the source edge and its mention; replace rewires source and mention", () => {
    const nodes = [node("a", CanvasNodeType.Image, { content: "a-data" }), node("b", CanvasNodeType.Image, { content: "b-data" }), node("video", CanvasNodeType.Video, { composerContent: "@图片1 是主体" })];
    const removed = run(nodes, [{ id: "a-edge", fromNodeId: "a", toNodeId: "video" }], { operation: "remove", targetNodeId: "video", sourceNodeId: "a" });
    expect(removed.connections).toEqual([]);
    expect(removed.composerContent).not.toContain("@图片1");
    const replaced = run(nodes, [{ id: "a-edge", fromNodeId: "a", toNodeId: "video" }], { operation: "replace", targetNodeId: "video", oldSourceNodeId: "a", sourceNodeId: "b" });
    expect(replaced.connections).toEqual([{ id: "a-edge", fromNodeId: "b", toNodeId: "video" }]);
    expect(replaced.composerContent).toContain("@[node:b]");
    expect(replaced.references[0].nodeId).toBe("b");
});

test("reorder changes reference edge ordering and rejects ambiguity or invalid IDs", () => {
    const nodes = [node("a", CanvasNodeType.Image, { content: "a-data" }), node("b", CanvasNodeType.Image, { content: "b-data" }), node("video", CanvasNodeType.Video)];
    const edges = [{ id: "a-edge", fromNodeId: "a", toNodeId: "video" }, { id: "b-edge", fromNodeId: "b", toNodeId: "video" }];
    const result = run(nodes, edges, { operation: "reorder", targetNodeId: "video", sourceNodeIds: ["b", "a"] });
    expect(result.connections.map((edge) => edge.id)).toEqual(["b-edge", "a-edge"]);
    expect(result.references.map((reference) => reference.nodeId)).toEqual(["b", "a"]);
    expect(() => run(nodes, edges, { operation: "add", targetNodeId: "video", sourceNodeId: "missing", connectionId: "x" })).toThrow("不存在");
    expect(() => run(nodes, [...edges, { id: "duplicate", fromNodeId: "a", toNodeId: "video" }], { operation: "remove", targetNodeId: "video", sourceNodeId: "a" })).toThrow("歧义");
});
