import { describe, expect, test } from "bun:test";

import { deriveStoryboardPipelineProgress, storyboardRowFocusNodeId, storyboardRowProductionDetails, storyboardRowProductionLabel } from "@/lib/canvas/canvas-storyboard-progress";
import { CanvasNodeType, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";

const row = (segmentBindings: NonNullable<StoryboardRow["segmentBindings"]>): StoryboardRow => ({
    id: "shot-01",
    shotNumber: 1,
    durationSeconds: 12,
    plotDescription: "",
    dialogue: "",
    characters: [],
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
    videoMotionPrompt: "",
    mustHave: [],
    optionalDetails: [],
    continuityOut: "",
    negativePrompt: "",
    assetBindings: [],
    requiredAssetRoles: [],
    segmentBindings,
});

const video = (id: string): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Video,
    title: id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    metadata: { status: "success", content: `resource:${id}` },
}) as CanvasNodeData;

describe("storyboard row production state", () => {
    test("keeps the canvas renderable when an incomplete row omits optional text fields", () => {
        const incompleteRow = { ...row([]), audioEffects: undefined, dialogue: undefined, characters: [{ characterDescription: undefined }] } as unknown as StoryboardRow;
        const script = { id: "script", type: CanvasNodeType.Script, metadata: { storyboard: { rows: [incompleteRow] } } } as CanvasNodeData;

        const progress = deriveStoryboardPipelineProgress(script, [script], []);

        expect(progress.rows[0].audioState).toBe("not_requested");
        expect(progress.rows[0].assetRequirementState).toBe("unknown");
    });

    test("distinguishes a missing required scene from a valid text-only T2V route", () => {
        const missingScene = { ...row([]), id: "shot-03", shotNumber: 3, sceneId: "scene-3", requiredAssetRoles: ["environment" as const], status: "ready" as const };
        const script = { id: "script", type: CanvasNodeType.Script, metadata: { storyboard: { rows: [missingScene] } } } as CanvasNodeData;
        const missing = deriveStoryboardPipelineProgress(script, [script], []).rows[0];

        expect(missing.assetRequirementState).toBe("missing_required_scene");
        expect(storyboardRowProductionLabel(missing)).toBe("缺必需场景");
        expect(storyboardRowProductionDetails(missing)).toContain("缺必需场景");

        const textOnly = { ...row([]), videoOperation: "text_to_video" as const, plotDescription: "雨夜里，林岚穿过空无一人的旧车站。", videoMotionPrompt: "缓慢跟拍，雨水打在车窗上。", status: "ready" as const };
        const textScript = { ...script, metadata: { storyboard: { rows: [textOnly] } } } as CanvasNodeData;
        const ready = deriveStoryboardPipelineProgress(textScript, [textScript], []).rows[0];

        expect(ready.videoRoute).toBe("t2v");
        expect(ready.assetRequirementState).toBe("text_only_ready");
        expect(storyboardRowProductionLabel(ready)).toBe("无需首帧");
        expect(storyboardRowProductionDetails(ready)).toContain("无需首帧/资产文字约束齐备");

        const sceneAsset: CanvasNodeData = { ...video("scene-asset"), type: CanvasNodeType.Image, metadata: { content: "resource:scene", assetCategory: "environment" } } as CanvasNodeData;
        const linkedOptionalAsset = { ...row([]), assetBindings: [{ nodeId: "scene-asset", role: "environment" as const, priority: 90 }] };
        const linkedScript = { ...script, metadata: { storyboard: { rows: [linkedOptionalAsset] } } } as CanvasNodeData;
        const linked = deriveStoryboardPipelineProgress(linkedScript, [linkedScript, sceneAsset], []).rows[0];
        expect(storyboardRowProductionDetails(linked)).toContain("资产已关联");
        expect(storyboardRowProductionDetails(linked)).not.toContain("必需资产已绑定");

        const requiredScene = { ...linkedOptionalAsset, requiredAssetRoles: ["environment" as const] };
        const requiredScript = { ...script, metadata: { storyboard: { rows: [requiredScene] } } } as CanvasNodeData;
        const satisfied = deriveStoryboardPipelineProgress(requiredScript, [requiredScript, sceneAsset], []).rows[0];
        expect(satisfied.assetRequirementState).toBe("satisfied");
        expect(storyboardRowProductionDetails(satisfied)).toContain("必需资产已绑定");
    });

    test("trusts explicit row roles for one ready image bound as both environment and prop", () => {
        const scene: CanvasNodeData = {
            ...video("shared-scene-prop"),
            type: CanvasNodeType.Image,
            metadata: { status: "success", storageKey: "resource:scene-prop" },
        } as CanvasNodeData;
        const boundRow = {
            ...row([]),
            requiredAssetRoles: ["environment", "prop"] as const,
            assetBindings: [
                { nodeId: scene.id, role: "environment" as const, priority: 3 },
                { nodeId: scene.id, role: "prop" as const, priority: 4 },
            ],
        };
        const script = { id: "script", type: CanvasNodeType.Script, metadata: { storyboard: { rows: [boundRow] } } } as CanvasNodeData;

        const item = deriveStoryboardPipelineProgress(script, [script, scene], []).rows[0];

        expect(item.assetRequirementState).toBe("satisfied");
        expect(storyboardRowProductionDetails(item)).toContain("必需资产已绑定");
    });

    test("aggregates ordered segment tasks and requires a real output binding before success", () => {
        const storyboard = row([
            { segmentId: "segment-b", order: 1, taskId: "task-2", status: "running" },
            { segmentId: "segment-a", order: 0, videoNodeId: "video-a", taskId: "task-1", resourceId: "resource-a", status: "succeeded" },
        ]);
        const script = { id: "script", type: CanvasNodeType.Script, metadata: { storyboard: { rows: [storyboard] } } } as CanvasNodeData;
        const progress = deriveStoryboardPipelineProgress(script, [script, video("video-a")], []);
        const item = progress.rows[0];

        expect(item.segmentNodeIds).toEqual(["video-a"]);
        expect(item.taskIds).toEqual(["task-1", "task-2"]);
        expect(item.videoState).toBe("loading");
        expect(storyboardRowProductionLabel(item)).toBe("视频进行中");
        expect(storyboardRowFocusNodeId(item)).toBe("video-a");

        const succeededWithoutOutput = row([
            { segmentId: "segment-a", order: 0, taskId: "task-1", status: "succeeded" },
        ]);
        const outputlessScript = { ...script, metadata: { storyboard: { rows: [succeededWithoutOutput] } } } as CanvasNodeData;
        const outputless = deriveStoryboardPipelineProgress(outputlessScript, [outputlessScript], []).rows[0];
        expect(outputless.videoState).toBe("missing");
        expect(storyboardRowProductionLabel(outputless)).toBe("结果待关联");

        const claimedWithoutNode = row([
            { segmentId: "segment-claimed", order: 0, taskId: "task-claimed", resourceId: "resource-claimed", status: "succeeded" },
        ]);
        const claimedScript = { ...script, metadata: { storyboard: { rows: [claimedWithoutNode] } } } as CanvasNodeData;
        const claimed = deriveStoryboardPipelineProgress(claimedScript, [claimedScript], []).rows[0];
        expect(claimed.videoState).toBe("missing");
        expect(claimed.segmentBindingsReady).toBe(false);
        expect(storyboardRowProductionLabel(claimed)).toBe("结果待关联");
    });

    test("requires the video node, succeeded task, and resource to match each segment binding", () => {
        const storyboard = row([
            { segmentId: "segment-a", order: 0, videoNodeId: "video-a", taskId: "task-a", resourceId: "resource-a", status: "succeeded" },
        ]);
        const script = { id: "script", type: CanvasNodeType.Script, metadata: { storyboard: { rows: [storyboard] } } } as CanvasNodeData;
        const matchingVideo = {
            ...video("video-a"),
            metadata: { status: "success", content: "resource:resource-a", storageKey: "resource:resource-a", taskId: "task-a", taskStatus: "succeeded" },
        } as CanvasNodeData;
        const matching = deriveStoryboardPipelineProgress(script, [script, matchingVideo], []).rows[0];
        expect(matching.videoState).toBe("success");
        expect(matching.segmentBindingsReady).toBe(true);
        expect(storyboardRowProductionLabel(matching)).toBe("片段完成 1/1");

        const mismatchedVideo = { ...matchingVideo, metadata: { ...matchingVideo.metadata, taskId: "another-task" } } as CanvasNodeData;
        const mismatched = deriveStoryboardPipelineProgress(script, [script, mismatchedVideo], []).rows[0];
        expect(mismatched.videoState).toBe("missing");
        expect(mismatched.segmentBindingsReady).toBe(false);
        expect(storyboardRowProductionLabel(mismatched)).toBe("结果待关联");
    });

    test("does not report a final merge node as a completed storyboard shot", () => {
        const storyboard = { ...row([]), status: "success" as const, videoNodeId: "final-video" };
        const script = { id: "script", type: CanvasNodeType.Script, metadata: { storyboard: { rows: [storyboard] } } } as CanvasNodeData;
        const finalVideo = {
            ...video("final-video"),
            metadata: { status: "success", content: "resource:final", storageKey: "resource:final", workflowKind: "final" },
        } as CanvasNodeData;
        const progress = deriveStoryboardPipelineProgress(script, [script, finalVideo], []);

        expect(progress.rows[0].videoState).toBe("missing");
        expect(storyboardRowProductionLabel(progress.rows[0])).toBe("结果待关联");
    });

    test("reports route and audio requirements and does not call a rendered clip delivered without contract evidence", () => {
        const storyboard = { ...row([]), dialogue: "你好", videoNodeId: "final-video" };
        const script = { id: "script", type: CanvasNodeType.Script, metadata: { storyboard: { rows: [storyboard] } } } as CanvasNodeData;
        const finalVideo = { ...video("final-video"), metadata: { status: "success", content: "resource:final", workflowKind: "final" } } as CanvasNodeData;
        const connections = [{ id: "c1", fromNodeId: "script", toNodeId: "final-video" }];
        const unverified = deriveStoryboardPipelineProgress(script, [script, finalVideo], connections);
        expect(unverified.rows[0].videoRoute).toBe("unknown");
        expect(unverified.rows[0].audioState).toBe("pending");
        expect(unverified.final.created).toBe(1);
        expect(unverified.final.success).toBe(0);
        expect(storyboardRowProductionDetails(unverified.rows[0])).toContain("镜头质检待验");

        const accepted = { ...finalVideo, metadata: { ...finalVideo.metadata, productionDeliveryStatus: "passed" } } as CanvasNodeData;
        const verified = deriveStoryboardPipelineProgress(script, [script, accepted], connections);
        expect(verified.final.success).toBe(1);
    });
});
