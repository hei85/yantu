import { describe, expect, it } from "bun:test";
import { collapsedStoryboardReferenceConnectionIds } from "@/lib/canvas/canvas-storyboard-connection-display";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";

const node = (id: string, type: CanvasNodeType, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({
    id, type, title: id, position: { x: 0, y: 0 }, width: 320, height: 180, metadata,
});
function fixture() {
    const rows = [1, 2].map((n) => ({
        id: `row-${n}`, shotNumber: n, durationSeconds: 3, videoNodeId: `video-${n}`,
        assetBindings: [{ nodeId: "girl", role: "character", priority: 2 }, { nodeId: `scene-${n}`, role: "environment", priority: 1 }],
        characters: [], videoMotionPrompt: "参考图片生成镜头", imageGenerationPrompt: "", plotDescription: "测试镜头",
    } as StoryboardRow));
    const nodes = [
        node("script", CanvasNodeType.Script, { storyboard: { rows, referenceNodeIds: [] } }),
        node("girl", CanvasNodeType.Image, { content: "data:image/png;base64,YQ==" }),
        ...[1, 2].flatMap((n) => [node(`scene-${n}`, CanvasNodeType.Image, { content: "data:image/png;base64,Yg==" }), node(`video-${n}`, CanvasNodeType.Video)]),
    ];
    const connections: CanvasConnection[] = rows.flatMap((row) => [
        { id: `output-${row.id}`, fromNodeId: "script", fromHandleId: `row:${row.id}`, toNodeId: row.videoNodeId!, relation: "storyboard-output", storyboardRowId: row.id },
        ...row.assetBindings!.flatMap((binding) => [
            { id: `input-${row.id}-${binding.nodeId}`, fromNodeId: binding.nodeId, toNodeId: "script", toHandleId: `row:${row.id}`, relation: "storyboard-asset-reference" as const, storyboardRowId: row.id },
            { id: `shortcut-${row.id}-${binding.nodeId}`, fromNodeId: binding.nodeId, toNodeId: row.videoNodeId!, relation: "storyboard-asset-reference" as const, storyboardRowId: row.id },
        ]),
    ]);
    return { nodes, connections };
}

describe("storyboard connection display", () => {
    it("collapses only duplicate shortcuts, preserving per-row assets and output paths", () => {
        const { nodes, connections } = fixture();
        const hidden = collapsedStoryboardReferenceConnectionIds(nodes, connections);
        expect(hidden.size).toBe(4);
        expect(connections.filter((edge) => !hidden.has(edge.id)).map((edge) => edge.id)).toEqual([
            "output-row-1", "input-row-1-girl", "input-row-1-scene-1",
            "output-row-2", "input-row-2-girl", "input-row-2-scene-2",
        ]);
    });
    it("does not mutate generation inputs, references or the saved graph", () => {
        const { nodes, connections } = fixture();
        const before = JSON.stringify({ nodes, connections });
        const prompt = "@[node:girl] @[node:scene-1] 生成视频";
        const context = buildNodeGenerationContext("video-1", nodes, connections, prompt, []);
        collapsedStoryboardReferenceConnectionIds(nodes, connections);
        expect(JSON.stringify({ nodes, connections })).toBe(before);
        expect(buildNodeGenerationContext("video-1", nodes, connections, prompt, [])).toEqual(context);
        expect(context.imageCount).toBe(2);
    });
    it("keeps manual connections, mismatched scenes and references with no alternate row path", () => {
        const { nodes, connections } = fixture();
        const extra: CanvasConnection[] = [
            { id: "manual", fromNodeId: "girl", toNodeId: "video-1" },
            { id: "other-scene", fromNodeId: "scene-2", toNodeId: "video-1", relation: "storyboard-asset-reference", storyboardRowId: "row-1" },
        ];
        const withoutSceneInput = connections.filter((edge) => edge.id !== "input-row-1-scene-1").concat(extra);
        const hidden = collapsedStoryboardReferenceConnectionIds(nodes, withoutSceneInput);
        expect(hidden.has("shortcut-row-1-scene-1")).toBe(false);
        expect(hidden.has("other-scene")).toBe(false);
        expect(hidden.has("manual")).toBe(false);
    });
    it("keeps references when the row output is missing or points at another row", () => {
        const { nodes, connections } = fixture();
        const withoutOutput = connections.filter((edge) => edge.id !== "output-row-1");
        expect(collapsedStoryboardReferenceConnectionIds(nodes, withoutOutput).has("shortcut-row-1-girl")).toBe(false);
        const wrongHandle = connections.map((edge) => edge.id === "output-row-1" ? { ...edge, fromHandleId: "row:row-2" } : edge);
        expect(collapsedStoryboardReferenceConnectionIds(nodes, wrongHandle).has("shortcut-row-1-girl")).toBe(false);
    });
    it("keeps first and last frame references that are not reusable row assets", () => {
        const { nodes, connections } = fixture();
        nodes.push(node("start-frame", CanvasNodeType.Image));
        const edge: CanvasConnection = { id: "start-frame", fromNodeId: "start-frame", toNodeId: "video-1", relation: "storyboard-asset-reference", storyboardRowId: "row-1" };
        expect(collapsedStoryboardReferenceConnectionIds(nodes, [...connections, edge]).has(edge.id)).toBe(false);
    });
});
