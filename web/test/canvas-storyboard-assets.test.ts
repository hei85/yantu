import { describe, expect, it } from "bun:test";

import { buildStoryboardAssetCatalog, normalizeStoryboardAssetBindings } from "@/lib/canvas/canvas-storyboard-assets";
import { attachNodeToStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { reconcileStoryboardTargetConnections, storyboardComposerContent, storyboardRowReferenceNodeIds } from "@/lib/canvas/canvas-storyboard-materializer";
import { buildCanvasNodeMentionReferenceMap, normalizeCanvasNodeMentionTokens } from "@/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";

const node = (id: string, type: CanvasNodeType, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({
    id,
    type,
    title: id,
    position: { x: 0, y: 0 },
    width: 320,
    height: 180,
    metadata,
});

const row: StoryboardRow = {
    id: "row-1",
    shotNumber: 1,
    durationSeconds: 6,
    plotDescription: "雨夜追逐",
    dialogue: "快走",
    characters: [{ characterName: "林岚", characterAssetId: "character-asset" }],
    narrativeIntent: "",
    viewerPOV: "",
    performanceBlocking: "",
    shotSize: "",
    emotion: "",
    lightingAndAtmosphere: "",
    audioEffects: "",
    camera: "",
    motion: "",
    timeBeats: "",
    imageGenerationPrompt: "",
    videoMotionPrompt: "快速跟拍",
    mustHave: [],
    optionalDetails: [],
    continuityOut: "",
    negativePrompt: "",
    assetBindings: [{ nodeId: "prop", role: "prop", priority: 80 }],
    imageNodeId: "first-frame",
    status: "idle",
};

describe("storyboard asset catalog", () => {
    it("preserves multiple semantic roles for one asset node while deduplicating repeated role bindings", () => {
        const bindings = normalizeStoryboardAssetBindings([
            { nodeId: "scene", role: "environment", priority: 3 },
            { nodeId: "scene", role: "prop", priority: 4 },
            { nodeId: "scene", role: "environment", priority: 7 },
        ]);

        expect(bindings).toEqual([
            { nodeId: "scene", role: "environment", priority: 7 },
            { nodeId: "scene", role: "prop", priority: 4 },
        ]);
    });

    it("sends reusable image, video, audio and character assets but excludes generated shots", () => {
        const assets = buildStoryboardAssetCatalog([
            node("image", CanvasNodeType.Image, { content: "data:image/png;base64,x", assetCategory: "environment" }),
            node("video", CanvasNodeType.Video, { storageKey: "resource:video" }),
            node("audio", CanvasNodeType.Audio, { content: "data:audio/wav;base64,x" }),
            node("character", CanvasNodeType.Image, { workflowKind: "character", characterAssetId: "character-asset", characterVersionId: "v1" }),
            node("shot", CanvasNodeType.Image, { content: "data:image/png;base64,x", workflowKind: "shot" }),
            node("text", CanvasNodeType.Text, { content: "story" }),
        ]);

        expect(assets.map((asset) => [asset.id, asset.type])).toEqual([
            ["image", "image"],
            ["video", "video"],
            ["audio", "audio"],
            ["character", "character"],
        ]);
    });
});

describe("storyboard target materializer", () => {
    const script = node("script", CanvasNodeType.Script, { storyboard: { rows: [row], visibleColumns: [], referenceNodeIds: ["project-style"] } });
    const nodes = [script, node("project-style", CanvasNodeType.Image, { content: "style" }), node("prop", CanvasNodeType.Image, { content: "prop" }), node("character", CanvasNodeType.Image, { workflowKind: "character", characterAssetId: "character-asset" }), node("manual", CanvasNodeType.Video, { content: "video" }), node("direct-manual", CanvasNodeType.Audio, { content: "audio" }), node("first-frame", CanvasNodeType.Image, { content: "frame", workflowKind: "shot" }), node("target", CanvasNodeType.Video)];
    const connections: CanvasConnection[] = [{ id: "manual-row-input", fromNodeId: "manual", toNodeId: "script", toHandleId: "row:row-1" }];

    it("combines stable bindings and produces position mention tokens", () => {
        const references = storyboardRowReferenceNodeIds(script, row, nodes, connections, true);
        expect(references).toEqual(["project-style", "prop", "character", "manual", "first-frame"]);
        expect(storyboardComposerContent("快速跟拍", references, nodes)).toBe("参考资产：@图片1 @图片2 @角色1 @视频1 @图片3\n快速跟拍");

        const withDirectManualInput = storyboardRowReferenceNodeIds(script, row, nodes, [...connections, { id: "direct", fromNodeId: "direct-manual", toNodeId: "target" }], false, "target");
        expect(withDirectManualInput).toContain("direct-manual");
    });

    it("normalizes storyboard node mentions before enqueue so the canvas sync effect cannot change the fingerprinted prompt", () => {
        const referenceIds = ["frame-1", "frame-2", "frame-3", "frame-4", "frame-5", "frame-6"];
        const references = referenceIds.map((id) => node(id, CanvasNodeType.Image, { content: `resource:${id}` }));
        const sixImageRow: StoryboardRow = {
            ...row,
            assetBindings: referenceIds.map((nodeId, index) => ({ nodeId, role: "style" as const, priority: 100 - index })),
            imageNodeId: referenceIds[0],
        };
        const scriptNode = node("six-frame-script", CanvasNodeType.Script, {
            storyboard: { rows: [sixImageRow], visibleColumns: [], referenceNodeIds: [] },
        });
        const target = node("six-frame-video", CanvasNodeType.Video);
        const nodes = [scriptNode, ...references, target];
        const prompt = referenceIds.map((id, index) => `<Picture ${index + 1}> = @[node:${id}]`).join("; ");
        const composer = storyboardComposerContent(prompt, referenceIds, nodes);
        const connections = reconcileStoryboardTargetConnections([], scriptNode, sixImageRow, target.id, referenceIds);
        const mentionReferences = buildCanvasNodeMentionReferenceMap(nodes, connections, [target]).get(target.id) || [];

        expect(composer).not.toContain("@[node:");
        expect(composer).toContain("<Picture 1> = @图片1");
        expect(composer).toContain("<Picture 6> = @图片6");
        expect(normalizeCanvasNodeMentionTokens(composer, mentionReferences)).toBe(composer);
    });

    it("reconciles managed edges without deleting manual connections", () => {
        const manualTargetEdge: CanvasConnection = { id: "manual-target", fromNodeId: "manual", toNodeId: "target" };
        const created = reconcileStoryboardTargetConnections([manualTargetEdge], script, row, "target", ["prop", "character"]);
        expect(created.filter((edge) => edge.relation === "storyboard-output")).toHaveLength(1);
        expect(created.filter((edge) => edge.relation === "storyboard-asset-reference")).toHaveLength(0);
        const imageCreated = reconcileStoryboardTargetConnections([manualTargetEdge], script, row, "target", ["prop", "character"], "image");
        expect(imageCreated.filter((edge) => edge.relation === "storyboard-output")).toHaveLength(0);
        expect(imageCreated.filter((edge) => edge.relation === "storyboard-asset-reference").map((edge) => edge.fromNodeId).sort()).toEqual(["character", "prop"]);

        const reconciled = reconcileStoryboardTargetConnections(imageCreated, script, row, "target", ["character"], "image");
        expect(reconciled.some((edge) => edge.id === "manual-target")).toBe(true);
        expect(reconciled.some((edge) => edge.relation === "storyboard-asset-reference" && edge.fromNodeId === "prop")).toBe(false);
        expect(reconciled.some((edge) => edge.relation === "storyboard-asset-reference" && edge.fromNodeId === "character")).toBe(true);
    });

    it("keeps multi-role bindings as one smart mention and one real asset edge per node", () => {
        const shared = node("shared-scene-prop", CanvasNodeType.Image, { content: "scene image" });
        const multiRoleRow = {
            ...row,
            assetBindings: [
                { nodeId: shared.id, role: "environment" as const, priority: 3 },
                { nodeId: shared.id, role: "prop" as const, priority: 4 },
            ],
        };
        const isolatedScript = node("isolated-script", CanvasNodeType.Script, { storyboard: { rows: [multiRoleRow], visibleColumns: [], referenceNodeIds: [] } });
        const references = storyboardRowReferenceNodeIds(isolatedScript, multiRoleRow, [isolatedScript, shared], [], false);
        const content = storyboardComposerContent("镜头描述", references, [isolatedScript, shared]);
        const edges = reconcileStoryboardTargetConnections([], isolatedScript, multiRoleRow, "target", references, "image")
            .filter((edge) => edge.relation === "storyboard-asset-reference");

        expect(references.filter((id) => id === shared.id)).toHaveLength(1);
        expect(content.match(/@图片\d+/g)).toHaveLength(1);
        expect(edges.filter((edge) => edge.fromNodeId === shared.id)).toHaveLength(1);
    });

    it("keeps an adopted first-frame input separate from shared asset roles", () => {
        const frame = node("opening-frame", CanvasNodeType.Image, { content: "opening image" });
        const script = node("script", CanvasNodeType.Script, {
            storyboard: { rows: [{ ...row, imageNodeId: frame.id, assetBindings: [] }], visibleColumns: [], referenceNodeIds: [] },
        });
        const updated = attachNodeToStoryboardRow([script, frame], {
            fromNodeId: frame.id, toNodeId: script.id, toHandleId: `row:${row.id}`,
        });
        expect(updated[0].metadata?.storyboard?.rows[0].imageNodeId).toBe(frame.id);
        expect(updated[0].metadata?.storyboard?.rows[0].assetBindings).toEqual([]);
    });

    it("adds a newly inferred role without discarding another explicit role for that node", () => {
        const scriptWithPropBinding = node("script", CanvasNodeType.Script, {
            storyboard: { rows: [{ ...row, assetBindings: [{ nodeId: "shared", role: "prop", priority: 80 }] }], visibleColumns: [], referenceNodeIds: [] },
        });
        const shared = node("shared", CanvasNodeType.Image, { content: "scene image", assetCategory: "environment" });
        const updated = attachNodeToStoryboardRow([scriptWithPropBinding, shared], {
            fromNodeId: shared.id,
            toNodeId: scriptWithPropBinding.id,
            toHandleId: `row:${row.id}`,
        });
        const savedRow = updated[0].metadata?.storyboard?.rows[0];

        expect(savedRow?.assetBindings).toEqual([
            { nodeId: shared.id, role: "prop", priority: 80 },
            { nodeId: shared.id, role: "environment", priority: 90 },
        ]);
    });

    it("isolates each storyboard row's smart mentions and target edges, and replaces only that row's scene", () => {
        const rowA: StoryboardRow = {
            ...row,
            id: "row-a",
            assetBindings: [
                { nodeId: "character-a", role: "character", priority: 100 },
                { nodeId: "scene-a", role: "environment", priority: 90 },
                { nodeId: "scene-a", role: "prop", priority: 80 },
            ],
            imageNodeId: undefined,
        };
        const rowB: StoryboardRow = {
            ...row,
            id: "row-b",
            assetBindings: [
                { nodeId: "character-b", role: "character", priority: 100 },
                { nodeId: "scene-b", role: "environment", priority: 90 },
            ],
            imageNodeId: undefined,
        };
        const isolatedScript = node("isolated-script", CanvasNodeType.Script, {
            storyboard: { rows: [rowA, rowB], visibleColumns: [], referenceNodeIds: [] },
        });
        const nodes = [
            isolatedScript,
            node("character-a", CanvasNodeType.Image, { content: "character A", workflowKind: "character" }),
            node("scene-a", CanvasNodeType.Image, { content: "scene A" }),
            node("character-b", CanvasNodeType.Image, { content: "character B", workflowKind: "character" }),
            node("scene-b", CanvasNodeType.Image, { content: "scene B" }),
            node("scene-a2", CanvasNodeType.Image, { content: "replacement scene A" }),
            node("image-a", CanvasNodeType.Image, { workflowKind: "shot" }),
            node("video-a", CanvasNodeType.Video, { workflowKind: "shot" }),
            node("image-b", CanvasNodeType.Image, { workflowKind: "shot" }),
            node("video-b", CanvasNodeType.Video, { workflowKind: "shot" }),
        ];
        const refsA = storyboardRowReferenceNodeIds(isolatedScript, rowA, nodes, [], false);
        const refsB = storyboardRowReferenceNodeIds(isolatedScript, rowB, nodes, [], false);
        expect(refsA).toEqual(["character-a", "scene-a"]);
        expect(refsB).toEqual(["character-b", "scene-b"]);
        expect(storyboardComposerContent("A", refsA, nodes)).toBe("参考资产：@图片1 @图片2\nA");
        expect(storyboardComposerContent("B", refsB, nodes)).toBe("参考资产：@图片1 @图片2\nB");

        let managed: CanvasConnection[] = [];
        managed = reconcileStoryboardTargetConnections(managed, isolatedScript, rowA, "image-a", refsA, "image");
        managed = reconcileStoryboardTargetConnections(managed, isolatedScript, rowA, "video-a", refsA);
        managed = reconcileStoryboardTargetConnections(managed, isolatedScript, rowB, "image-b", refsB, "image");
        managed = reconcileStoryboardTargetConnections(managed, isolatedScript, rowB, "video-b", refsB);
        const assetSources = (targetId: string) => managed
            .filter((connection) => connection.toNodeId === targetId && connection.relation === "storyboard-asset-reference")
            .map((connection) => connection.fromNodeId).sort();
        expect(assetSources("image-a")).toEqual(["character-a", "scene-a"]);
        expect(assetSources("video-a")).toEqual([]);
        expect(assetSources("image-b")).toEqual(["character-b", "scene-b"]);
        expect(assetSources("video-b")).toEqual([]);
        expect(managed.filter((connection) => connection.relation === "storyboard-output" && connection.fromHandleId === `row:${rowA.id}`)).toHaveLength(1);
        expect(managed.filter((connection) => connection.relation === "storyboard-output" && connection.fromHandleId === `row:${rowB.id}`)).toHaveLength(1);
        const rowBConnectionsBeforeReplacement = managed.filter((connection) => connection.storyboardRowId === rowB.id);

        const rowAWithReplacement: StoryboardRow = {
            ...rowA,
            assetBindings: [
                { nodeId: "character-a", role: "character", priority: 100 },
                { nodeId: "scene-a2", role: "environment", priority: 90 },
                { nodeId: "scene-a2", role: "prop", priority: 80 },
            ],
        };
        const replacementRefs = storyboardRowReferenceNodeIds(isolatedScript, rowAWithReplacement, nodes, [], false);
        managed = reconcileStoryboardTargetConnections(managed, isolatedScript, rowAWithReplacement, "image-a", replacementRefs, "image");
        managed = reconcileStoryboardTargetConnections(managed, isolatedScript, rowAWithReplacement, "video-a", replacementRefs);

        expect(assetSources("image-a")).toEqual(["character-a", "scene-a2"]);
        expect(assetSources("video-a")).toEqual([]);
        expect(assetSources("image-b")).toEqual(["character-b", "scene-b"]);
        expect(assetSources("video-b")).toEqual([]);
        expect(managed.filter((connection) => connection.storyboardRowId === rowB.id)).toEqual(rowBConnectionsBeforeReplacement);
        expect(storyboardComposerContent("A", replacementRefs, nodes)).toBe("参考资产：@图片1 @图片2\nA");
    });
});
