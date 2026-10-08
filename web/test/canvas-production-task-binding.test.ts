import { describe, expect, test } from "bun:test";

import { bindProductionTaskCanvasContext, generationTaskBelongsToCanvas } from "@/lib/canvas/canvas-production-task-binding";
import type { GenerationTask } from "@/services/api/task-center";
import type { CanvasNodeData } from "@/types/canvas";

const canvasNodes = [
    {
        id: "script-1",
        type: "script",
        metadata: {
            storyboard: {
                rows: [{ id: "row-1", imageNodeId: "image-1", videoNodeId: "video-1", segmentBindings: [{ segmentId: "segment-1", videoNodeId: "video-1" }] }],
            },
        },
    },
    { id: "video-1", type: "video", metadata: {} },
    { id: "image-1", type: "image", metadata: {} },
] as unknown as CanvasNodeData[];

const run = {
    id: "run-1",
    canvasId: "canvas-1",
    domainProjectId: "domain-project-1",
    plan: {
        productionSpec: {
            storyboardRows: [{ rowId: "row-1", videoNodeId: "video-1", segments: [{ segmentId: "segment-1" }] }],
        },
    },
};

const firstFrameRun = {
    ...run,
    plan: { productionSpec: { storyboardRows: [{ rowId: "row-1", imageNodeId: "image-1", videoNodeId: "video-1" }] } },
    steps: [{ id: "first-frame-step", stepKey: "first-frame:row-1", kind: "image", storyboardRowId: "row-1" }],
};

const task = (patch: Partial<GenerationTask> = {}) => ({
    id: "task-1",
    userId: "user-1",
    productionRunId: "run-1",
    productionStepId: "step-1",
    projectId: "domain-project-1",
    storyboardRowId: "row-1",
    segmentId: "segment-1",
    type: "canvas_video",
    status: "succeeded",
    prompt: "shot",
    attempts: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    inputJson: JSON.stringify({ metadata: { canvasId: "canvas-1", productionRunId: "run-1", nodeId: "video-1", storyboardRowId: "row-1", segmentId: "segment-1" } }),
    ...patch,
}) as GenerationTask;

describe("ProductionRun task canvas binding", () => {
    test("binds a formal first-frame image step to the storyboard row image node, not its video node", () => {
        const submitted = bindProductionTaskCanvasContext(
            { type: "canvas_image", input: { mode: "image" } },
            firstFrameRun,
            { id: "first-frame-step", kind: "image", stepKey: "first-frame:row-1", storyboardRowId: "row-1" },
            canvasNodes,
        );
        expect(submitted.input?.metadata).toEqual({
            canvasId: "canvas-1",
            productionRunId: "run-1",
            storyboardRowId: "row-1",
            nodeId: "image-1",
        });
        expect(() => bindProductionTaskCanvasContext(
            { type: "canvas_image", input: { metadata: { nodeId: "video-1" } } },
            firstFrameRun,
            { id: "first-frame-step", kind: "image", stepKey: "first-frame:row-1", storyboardRowId: "row-1" },
            canvasNodes,
        )).toThrow("metadata.nodeId 与分镜目标节点不一致");
        expect(() => bindProductionTaskCanvasContext(
            { type: "canvas_image", input: {} },
            firstFrameRun,
            { id: "first-frame-step", kind: "image", stepKey: "first-frame:row-2", storyboardRowId: "row-1" },
            canvasNodes,
        )).toThrow("首帧步骤");
    });

    test("recovers only the first-frame task bound to the same persisted step, row, and image node", async () => {
        const firstFrameTask = task({
            type: "canvas_image",
            productionStepId: "first-frame-step",
            segmentId: undefined,
            inputJson: JSON.stringify({ metadata: { canvasId: "canvas-1", productionRunId: "run-1", nodeId: "image-1", storyboardRowId: "row-1" } }),
        });
        const options = {
            task: firstFrameTask,
            canvasId: "canvas-1",
            domainProjectId: "domain-project-1",
            nodeType: "image",
            userId: "user-1",
            canvasNodes,
            getProductionRun: async () => firstFrameRun,
        };
        expect(await generationTaskBelongsToCanvas({ ...options, nodeId: "image-1" })).toBe(true);
        expect(await generationTaskBelongsToCanvas({ ...options, nodeId: "video-1" })).toBe(false);
        expect(await generationTaskBelongsToCanvas({ ...options, nodeId: "image-1", task: { ...firstFrameTask, productionStepId: "other-step" } })).toBe(false);
        expect(await generationTaskBelongsToCanvas({ ...options, nodeId: "image-1", task: { ...firstFrameTask, storyboardRowId: "other-row" } })).toBe(false);
    });

    test("binds an asset image task to the authoritative target without requiring caller node metadata", () => {
        const assetRun = { ...run, plan: { assetTargets: [{ assetId: "girl", nodeId: "image-1" }] } };
        const submitted = bindProductionTaskCanvasContext(
            { type: "canvas_image", input: { mode: "image" } },
            assetRun,
            { kind: "image", stepKey: "asset:girl" },
            canvasNodes,
        );
        expect(submitted.input?.metadata).toEqual({ canvasId: "canvas-1", productionRunId: "run-1", nodeId: "image-1" });
        expect(() => bindProductionTaskCanvasContext(
            { type: "canvas_image", input: { metadata: { nodeId: "video-1" } } },
            assetRun,
            { kind: "image", stepKey: "asset:girl" },
            canvasNodes,
        )).toThrow("资产目标节点");
    });

    test("recovers a legacy image task only when its production step traces to this exact asset node", async () => {
        const assetRun = { ...run, plan: { assetTargets: [{ assetId: "girl", nodeId: "image-1" }] }, steps: [{ id: "step-1", kind: "image", stepKey: "asset:girl" }] };
        const legacyImage = task({ type: "canvas_image", projectId: undefined, storyboardRowId: undefined, segmentId: undefined, inputJson: JSON.stringify({ metadata: { canvasId: "canvas-1", productionRunId: "run-1" } }) });
        const options = { task: legacyImage, canvasId: "canvas-1", domainProjectId: "domain-project-1", nodeType: "image", userId: "user-1", canvasNodes, getProductionRun: async () => assetRun };
        expect(await generationTaskBelongsToCanvas({ ...options, nodeId: "image-1" })).toBe(true);
        expect(await generationTaskBelongsToCanvas({ ...options, nodeId: "other-image" })).toBe(false);
        expect(await generationTaskBelongsToCanvas({ ...options, nodeId: "image-1", task: { ...legacyImage, productionStepId: "unknown-step" } })).toBe(false);
    });

    test("accepts a current-user task whose run, project, storyboard row and segment trace to this canvas node", async () => {
        const belongs = await generationTaskBelongsToCanvas({
            task: task(),
            canvasId: "canvas-1",
            domainProjectId: "domain-project-1",
            nodeId: "video-1",
            nodeType: "video",
            userId: "user-1",
            canvasNodes,
            getProductionRun: async () => run,
        });

        expect(belongs).toBe(true);
    });

    test("accepts a traceable same-canvas ProductionRun task with an empty projectId", async () => {
        const belongs = await generationTaskBelongsToCanvas({
            task: task({ projectId: undefined }),
            canvasId: "canvas-1",
            domainProjectId: "domain-project-1",
            nodeId: "video-1",
            nodeType: "video",
            userId: "user-1",
            canvasNodes,
            getProductionRun: async () => run,
        });

        expect(belongs).toBe(true);
    });

    test("recovers a missing local project binding only with a verified server canvas link", async () => {
        const input = {
            task: task(), canvasId: "canvas-1", nodeId: "video-1", nodeType: "video",
            userId: "user-1", canvasNodes, getProductionRun: async () => run,
        };
        expect(await generationTaskBelongsToCanvas(input)).toBe(false);
        expect(await generationTaskBelongsToCanvas({ ...input,
            getProjectCanvasLinks: async () => [{ projectId: "domain-project-1", canvasId: "canvas-1" }],
        })).toBe(true);
        expect(await generationTaskBelongsToCanvas({ ...input,
            getProjectCanvasLinks: async () => [{ projectId: "domain-project-1", canvasId: "other-canvas" }],
        })).toBe(false);
        expect(await generationTaskBelongsToCanvas({ ...input, domainProjectId: "other-project",
            getProjectCanvasLinks: async () => [{ projectId: "domain-project-1", canvasId: "canvas-1" }],
        })).toBe(false);
    });

    test("verifies row and segment against a persisted executionManifest when the run omits its source spec", async () => {
        const persistedRun = {
            ...run,
            plan: { executionManifest: { selectedModelsBySegment: [{ storyboardRowId: "row-1", segmentId: "segment-1" }] } },
        };
        const belongs = await generationTaskBelongsToCanvas({
            task: task(),
            canvasId: "canvas-1",
            domainProjectId: "domain-project-1",
            nodeId: "video-1",
            nodeType: "video",
            userId: "user-1",
            canvasNodes,
            getProductionRun: async () => persistedRun,
        });

        expect(belongs).toBe(true);
    });

    test("rejects a ProductionRun tied to a different canvas", async () => {
        const belongs = await generationTaskBelongsToCanvas({
            task: task(),
            canvasId: "canvas-1",
            domainProjectId: "domain-project-1",
            nodeId: "video-1",
            nodeType: "video",
            userId: "user-1",
            canvasNodes,
            getProductionRun: async () => ({ ...run, canvasId: "canvas-2" }),
        });

        expect(belongs).toBe(false);
    });

    test("rejects a ProductionRun task owned by another user before reading the run", async () => {
        let runRead = false;
        const belongs = await generationTaskBelongsToCanvas({
            task: task({ userId: "user-2" }),
            canvasId: "canvas-1",
            domainProjectId: "domain-project-1",
            nodeId: "video-1",
            nodeType: "video",
            userId: "user-1",
            canvasNodes,
            getProductionRun: async () => {
                runRead = true;
                return run;
            },
        });

        expect(belongs).toBe(false);
        expect(runRead).toBe(false);
    });

    test("rejects an untraceable task instead of binding it by run ID alone", async () => {
        const belongs = await generationTaskBelongsToCanvas({
            task: task({
                storyboardRowId: undefined,
                segmentId: undefined,
                inputJson: JSON.stringify({ metadata: { canvasId: "canvas-1", productionRunId: "run-1" } }),
            }),
            canvasId: "canvas-1",
            domainProjectId: "domain-project-1",
            nodeId: "video-1",
            nodeType: "video",
            userId: "user-1",
            canvasNodes,
            getProductionRun: async () => run,
        });

        expect(belongs).toBe(false);
    });

    test("rejects a canvas video task when recovery targets a non-video node", async () => {
        const belongs = await generationTaskBelongsToCanvas({
            task: task(),
            canvasId: "canvas-1",
            domainProjectId: "domain-project-1",
            nodeId: "video-1",
            nodeType: "image",
            userId: "user-1",
            canvasNodes,
            getProductionRun: async () => run,
        });

        expect(belongs).toBe(false);
    });

    test("stamps canvas and storyboard provenance onto submitted ProductionRun video tasks", () => {
        const submitted = bindProductionTaskCanvasContext(
            { type: "canvas_video", projectId: "domain-project-1", input: { mode: "video", metadata: { sourceNodeId: "image-1" } } },
            run,
            { kind: "video", storyboardRowId: "row-1", segmentId: "segment-1" },
            canvasNodes,
        );

        expect(submitted.projectId).toBe("domain-project-1");
        expect(submitted.input?.metadata).toEqual({
            sourceNodeId: "image-1",
            canvasId: "canvas-1",
            productionRunId: "run-1",
            storyboardRowId: "row-1",
            segmentId: "segment-1",
            nodeId: "video-1",
        });
    });

    test("rejects conflicting submitted canvas or node provenance", () => {
        expect(() => bindProductionTaskCanvasContext(
            { type: "canvas_video", input: { metadata: { canvasId: "canvas-2" } } },
            run,
            { kind: "video", storyboardRowId: "row-1", segmentId: "segment-1" },
            canvasNodes,
        )).toThrow("canvasId");
        expect(() => bindProductionTaskCanvasContext(
            { type: "canvas_video", input: { metadata: { nodeId: "other-video" } } },
            run,
            { kind: "video", storyboardRowId: "row-1", segmentId: "segment-1" },
            canvasNodes,
        )).toThrow("nodeId");
    });
});
