import assert from "node:assert/strict";
import { test } from "node:test";

import { filmBindingResolutionHint, hydrateFilmPlanFromCanvasStoryboard } from "../src/film-storyboard-binding.js";
import type { CanvasSnapshot } from "../src/types.js";

const canvasState: CanvasSnapshot = {
    nodes: [{
        id: "script-current",
        type: "script",
        position: { x: 0, y: 0 },
        width: 640,
        height: 420,
        metadata: {
            storyboard: {
                rows: [{
                    id: "row-existing",
                    imageNodeId: "image-first-frame",
                    videoNodeId: "video-existing",
                    segmentBindings: [{
                        segmentId: "segment-existing",
                        order: 0,
                        videoNodeId: "video-existing",
                        taskId: "task-existing",
                        resourceId: "resource-existing",
                        model: "channel::model",
                        capabilityRevision: "model-capability:4",
                        requestedDurationSeconds: 13,
                        timelineStartMs: 0,
                        timelineDurationMs: 13_667,
                        status: "succeeded",
                    }],
                }],
            },
        },
    }],
};

test("film plan hydration uses current Script row and segment bindings as its media reuse source", () => {
    const input = {
        clientKey: "reuse-test",
        plan: {
            productionSpec: {
                version: 1,
                targetDurationMs: 13_667,
                targetAspectRatio: "16:9",
                videoModels: [],
                storyboardRows: [{
                    rowId: "row-existing",
                    durationMs: 13_667,
                    segments: [{ segmentId: "segment-existing", order: 0, durationSeconds: 13.667 }],
                }],
            },
        },
    };

    const hydrated = hydrateFilmPlanFromCanvasStoryboard(input, canvasState);
    const spec = hydrated.plan.productionSpec;
    const row = spec.storyboardRows[0];
    assert.equal(row.imageNodeId, "image-first-frame");
    assert.equal(row.videoNodeId, "video-existing");
    assert.deepEqual(row.segments[0].existingMedia, {
        resourceId: "resource-existing",
        sourceTaskId: "task-existing",
        sourceNodeId: "video-existing",
    });
    assert.equal(row.segmentBindings[0].capabilityRevision, "model-capability:4");
    assert.equal(row.segmentBindings[0].timelineDurationMs, 13_667);
    assert.equal(row.segmentBindings[0].status, "succeeded");
    assert.equal(input.plan.productionSpec.storyboardRows[0].segments[0].existingMedia, undefined);
    assert.equal(filmBindingResolutionHint(hydrated, canvasState), "");
});

test("film plan hydration rejects conflicting bindings and duplicate Script row IDs", () => {
    const conflicting = {
        plan: {
            productionSpec: {
                storyboardRows: [{
                    rowId: "row-existing",
                    segments: [{ segmentId: "segment-existing", existingMedia: { resourceId: "other-resource" } }],
                }],
            },
        },
    };
    assert.throws(() => hydrateFilmPlanFromCanvasStoryboard(conflicting, canvasState), /与当前画布 SegmentBinding 不一致/);

    assert.throws(() => hydrateFilmPlanFromCanvasStoryboard({
        plan: { productionSpec: { storyboardRows: [{ rowId: "row-existing", imageNodeId: "other-image" }] } },
    }, canvasState), /imageNodeId 与当前画布 Script 不一致/);

    const duplicateState = {
        ...canvasState,
        nodes: [...(canvasState.nodes || []), ...(canvasState.nodes || [])],
    };
    assert.throws(() => hydrateFilmPlanFromCanvasStoryboard({
        plan: { productionSpec: { storyboardRows: [{ rowId: "row-existing" }] } },
    }, duplicateState), /多个 Script 来源/);

    const unresolved = hydrateFilmPlanFromCanvasStoryboard({
        plan: { productionSpec: { videoModels: [], storyboardRows: [{ rowId: "row-missing", segments: [{ segmentId: "segment-missing" }] }] } },
    }, canvasState);
    assert.match(filmBindingResolutionHint(unresolved, canvasState), /row-missing/);
    assert.match(filmBindingResolutionHint(unresolved, canvasState), /row-existing/);
});
