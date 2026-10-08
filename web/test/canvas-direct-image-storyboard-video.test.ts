import { describe, expect, it } from "bun:test";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { buildCanvasNodeMentionReferenceMap, buildNodeMentionReferences, getContextResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { reconcileStoryboardTargetConnections } from "@/lib/canvas/canvas-storyboard-materializer";
import { collapsedStoryboardReferenceConnectionIds } from "@/lib/canvas/canvas-storyboard-connection-display";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";

const node = (id: string, type: CanvasNodeType, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({
    id, type, title: id, position: { x: 0, y: 0 }, width: 320, height: 180, metadata,
});
function fixture() {
    const rows = [1, 2].map((n) => ({
        id: `row-${n}`, shotNumber: n, durationSeconds: 3, imageNodeId: `frame-${n}`, videoNodeId: `video-${n}`,
        assetBindings: [{ nodeId: "girl", role: "character" }, { nodeId: `scene-${n}`, role: "environment" }],
        characters: [], imageGenerationPrompt: "画一个场景", videoMotionPrompt: "连续动作", plotDescription: "剧情",
    } as StoryboardRow));
    const script = node("script", CanvasNodeType.Script, { storyboard: { rows, referenceNodeIds: [] } });
    const images = ["girl", "scene-1", "scene-2", "frame-1", "frame-2"].map((id) => node(id, CanvasNodeType.Image, { content: "data:image/png;base64,YQ==" }));
    const nodes = [script, ...images, node("image-out", CanvasNodeType.Image), node("video-1", CanvasNodeType.Video), node("video-2", CanvasNodeType.Video)];
    const connections: CanvasConnection[] = rows.map((row) => ({
        id: `output-${row.id}`, fromNodeId: script.id, fromHandleId: `row:${row.id}`, toNodeId: row.videoNodeId!,
        relation: "storyboard-output", storyboardRowId: row.id,
    }));
    return { rows, script, nodes, connections };
}

describe("direct picture references and row-driven video", () => {
    it("a video extracts only its own row's pictures and first frame through one storyboard wire", () => {
        const { nodes, connections } = fixture();
        expect(getContextResourceNodes("video-1", nodes, connections).map((n) => n.id)).toEqual(["girl", "scene-1", "frame-1"]);
        const context = buildNodeGenerationContext("video-1", nodes, connections, "@[node:girl] @[node:scene-1] @[node:frame-1] 连续动作", []);
        expect(context.referenceImages.map((image) => image.id)).toEqual(["girl", "scene-1", "frame-1"]);
        expect(context.imageCount).toBe(3);
        expect(context.referenceImages.some((image) => image.id === "scene-2")).toBe(false);
    });
    it("legacy duplicate video reference wires neither duplicate inputs nor change their identity", () => {
        const { nodes, connections } = fixture();
        const legacy = [...connections, { id: "legacy", fromNodeId: "girl", toNodeId: "video-1", relation: "storyboard-asset-reference" as const, storyboardRowId: "row-1" }];
        expect(getContextResourceNodes("video-1", nodes, legacy)).toEqual(getContextResourceNodes("video-1", nodes, connections));
    });
    it("the batched smart reference shelf agrees with generation inputs inherited from a storyboard row", () => {
        const { nodes, connections } = fixture();
        const video = nodes.find((item) => item.id === "video-1")!;
        const shelf = buildCanvasNodeMentionReferenceMap(nodes, connections).get(video.id)!;
        expect(shelf).toEqual(buildNodeMentionReferences(video, nodes, connections));
        expect(shelf.map((item) => item.label)).toEqual(["图片1", "图片2", "图片3"]);
    });
    it("video settings retain the same row references when the storyboard wire ends at the configuration node", () => {
        const { nodes, connections } = fixture();
        const config = node("settings", CanvasNodeType.Config);
        nodes.push(config);
        const updated = connections.map((edge) => edge.toNodeId === "video-1" ? { ...edge, toNodeId: config.id } : edge);
        updated.push({ id: "video-settings", fromNodeId: "video-1", toNodeId: config.id });
        const video = nodes.find((item) => item.id === "video-1")!;
        const shelf = buildCanvasNodeMentionReferenceMap(nodes, updated).get(video.id)!;
        expect(shelf).toEqual(buildNodeMentionReferences(video, nodes, updated));
        expect(shelf.map((item) => item.label)).toEqual(["图片1", "图片2", "图片3"]);
        expect(buildNodeGenerationContext(video.id, nodes, updated, "连续动作", []).referenceImages.map((image) => image.id)).toEqual(["girl", "scene-1", "frame-1"]);
    });
    it("image materialization removes the storyboard detour and preserves its direct picture references", () => {
        const { rows, script, nodes, connections } = fixture();
        const detour: CanvasConnection = { id: "image-detour", fromNodeId: script.id, fromHandleId: "row:row-1", toNodeId: "image-out", relation: "storyboard-output", storyboardRowId: "row-1" };
        const revised = reconcileStoryboardTargetConnections([...connections, detour], script, rows[0], "image-out", ["girl", "scene-1"], "image");
        expect(revised.filter((edge) => edge.toNodeId === "image-out").map((edge) => edge.fromNodeId)).toEqual(["girl", "scene-1"]);
        expect(buildNodeGenerationContext("image-out", nodes, revised, "画一个场景", []).referenceImages.map((image) => image.id)).toEqual(["girl", "scene-1"]);
        expect(collapsedStoryboardReferenceConnectionIds(nodes, revised).size).toBe(0);
    });
    it("video materialization keeps one row output plus manual references, without recreating derived shortcuts", () => {
        const { rows, script, nodes, connections } = fixture();
        const legacy: CanvasConnection = { id: "legacy", fromNodeId: "girl", toNodeId: "video-1", relation: "storyboard-asset-reference", storyboardRowId: "row-1" };
        const manual: CanvasConnection = { id: "manual", fromNodeId: "scene-2", toNodeId: "video-1" };
        const revised = reconcileStoryboardTargetConnections([...connections, legacy, manual], script, rows[0], "video-1", ["girl", "scene-1", "frame-1"]);
        expect(revised.filter((edge) => edge.toNodeId === "video-1").map((edge) => edge.id)).toEqual(["output-row-1", "manual"]);
        expect(getContextResourceNodes("video-1", nodes, revised).map((n) => n.id)).toEqual(["girl", "scene-1", "frame-1", "scene-2"]);
    });
    it("invalid row handles do not borrow other scenes or forward pictures through an image target", () => {
        const { nodes, connections } = fixture();
        const wrong = connections.map((edge) => edge.toNodeId === "video-1" ? { ...edge, storyboardRowId: "row-2" } : edge);
        expect(getContextResourceNodes("video-1", nodes, wrong)).toEqual([]);
        expect(getContextResourceNodes("image-out", nodes, [{ id: "unwanted-detour", fromNodeId: "script", fromHandleId: "row:row-1", toNodeId: "image-out" }])).toEqual([]);
    });
});
