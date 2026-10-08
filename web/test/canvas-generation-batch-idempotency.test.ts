import assert from "node:assert/strict";
import { test } from "node:test";

import { batchRowClientOperationId, batchRowRequestFingerprint } from "../src/lib/canvas/canvas-generation-batch-idempotency";
import type { CanvasNodeData } from "../src/types/canvas";

test("batch row client operation IDs are deterministic, row scoped, and bounded", () => {
    const first = batchRowClientOperationId("storyboard-op-1", "row-1");
    assert.equal(first, batchRowClientOperationId("storyboard-op-1", "row-1"));
    assert.notEqual(first, batchRowClientOperationId("storyboard-op-1", "row-2"));
    assert.ok(first.length < 120);
});

test("batch request fingerprint binds prompt, model, storyboard row and referenced assets", () => {
    const target: CanvasNodeData = { id: "image-1", type: "image", title: "镜头图", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { prompt: "海边日落" } };
    const reference: CanvasNodeData = { id: "asset-1", type: "image", title: "角色参考", position: { x: -200, y: 0 }, width: 100, height: 100, metadata: { assetId: "asset-1", content: "resource:one" } };
    const source: CanvasNodeData = {
        id: "script-1", type: "script", title: "脚本", position: { x: -400, y: 0 }, width: 300, height: 200,
        metadata: { storyboard: { referenceNodeIds: ["asset-1"], rows: [{ id: "row-1", assetBindings: [{ nodeId: "asset-1", role: "character" }], plotDescription: "海边" }] } },
    };
    const options = { size: "1024", quality: "high" };
    const baseline = batchRowRequestFingerprint("canvas-1", "row-1", target, "image", "model-1", options, source, [target, reference, source]);
    assert.equal(baseline, batchRowRequestFingerprint("canvas-1", "row-1", target, "image", "model-1", options, source, [target, reference, source]));
    const changedPrompt = { ...target, metadata: { ...target.metadata, prompt: "雨夜街道" } };
    assert.notEqual(baseline, batchRowRequestFingerprint("canvas-1", "row-1", changedPrompt, "image", "model-1", options, source, [changedPrompt, reference, source]));
    const changedRow: CanvasNodeData = { ...source, metadata: { ...source.metadata, storyboard: { ...source.metadata?.storyboard, rows: [{ id: "row-1", assetBindings: [{ nodeId: "asset-2", role: "character" }], plotDescription: "海边" }] } } };
    assert.notEqual(baseline, batchRowRequestFingerprint("canvas-1", "row-1", target, "image", "model-1", options, changedRow, [target, reference, changedRow]));
    const changedReference: CanvasNodeData = { ...reference, updatedAt: "new", metadata: { ...reference.metadata, content: "resource:two" } };
    assert.notEqual(baseline, batchRowRequestFingerprint("canvas-1", "row-1", target, "image", "model-1", options, source, [target, changedReference, source]));
    assert.notEqual(baseline, batchRowRequestFingerprint("canvas-1", "row-1", target, "image", "model-2", options, source, [target, reference, source]));
});

test("video batch fingerprint binds the effective start frame node and its content version", () => {
    const video: CanvasNodeData = { id: "video-1", type: "video", title: "镜头视频", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { prompt: "向前推镜", videoStartFrameNodeId: "frame-1" } };
    const frame: CanvasNodeData = { id: "frame-1", type: "image", title: "首帧", position: { x: -200, y: 0 }, width: 100, height: 100, metadata: { content: "resource:first-frame-v1" } };
    const source: CanvasNodeData = { id: "script-1", type: "script", title: "脚本", position: { x: -400, y: 0 }, width: 300, height: 200, metadata: { storyboard: { rows: [{ id: "row-1", plotDescription: "向前推镜" }] } } };
    const options = { seconds: 4 };
    const baseline = batchRowRequestFingerprint("canvas-1", "row-1", video, "video", "model-1", options, source, [video, frame, source]);
    const changedFrame = { ...frame, metadata: { ...frame.metadata, content: "resource:first-frame-v2" } };
    assert.notEqual(baseline, batchRowRequestFingerprint("canvas-1", "row-1", video, "video", "model-1", options, source, [video, changedFrame, source]));
    const changedTarget = { ...video, metadata: { ...video.metadata, videoStartFrameNodeId: "frame-2" } };
    assert.notEqual(baseline, batchRowRequestFingerprint("canvas-1", "row-1", changedTarget, "video", "model-1", options, source, [changedTarget, frame, source]));
});

test("batch fingerprint ignores media hydration representation changes when storage identity is stable", () => {
    const target: CanvasNodeData = { id: "video-1", type: "video", title: "镜头视频", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { prompt: "向前推镜", videoStartFrameNodeId: "frame-1" } };
    const frame: CanvasNodeData = { id: "frame-1", type: "image", title: "首帧", position: { x: -200, y: 0 }, width: 100, height: 100, updatedAt: "2026-10-02T10:00:00.000Z", metadata: { assetId: "asset-1", storageKey: "resource:frame-v1", content: "resource:frame-v1" } };
    const source: CanvasNodeData = { id: "script-1", type: "script", title: "脚本", position: { x: -400, y: 0 }, width: 300, height: 200, metadata: { storyboard: { rows: [{ id: "row-1", plotDescription: "向前推镜" }] } } };
    const fingerprint = (reference: CanvasNodeData) => batchRowRequestFingerprint("canvas-1", "row-1", target, "video", "model-1", { seconds: 8 }, source, [target, reference, source]);

    const queuedFingerprint = fingerprint(frame);
    const hydratedFrame = { ...frame, metadata: { ...frame.metadata, content: "data:image/png;base64,hydrated-preview" } };
    assert.equal(fingerprint(hydratedFrame), queuedFingerprint);

    const changedResource = { ...hydratedFrame, metadata: { ...hydratedFrame.metadata, storageKey: "resource:frame-v2" } };
    assert.notEqual(fingerprint(changedResource), queuedFingerprint);
    const changedContentWithoutStableKey = { ...hydratedFrame, metadata: { ...hydratedFrame.metadata, storageKey: undefined } };
    assert.notEqual(fingerprint(changedContentWithoutStableKey), queuedFingerprint);
});

test("batch image fingerprint binds row reference assets, text refs, and prompt changes", () => {
    const target: CanvasNodeData = { id: "out-1", type: "image", title: "创意", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { prompt: "make it", batchSourceNodeId: "table-1", batchRowId: "row-1" } };
    const reference: CanvasNodeData = { id: "ref-1", type: "image", title: "参考", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "image-v1", assetId: "asset-v1" } };
    const text: CanvasNodeData = { id: "text-1", type: "text", title: "备注", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "blue coat" } };
    const source: CanvasNodeData = { id: "table-1", type: "batch_table", title: "表", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { batchTable: { operation: "creative", globalPrompt: "global", rows: [{ id: "row-1", enabled: true, inputNodeIds: ["ref-1"], textNodeIds: ["text-1"], prompt: "local" }] } } };
    const fingerprint = (sourceNode: CanvasNodeData, nodes = [target, reference, text, source]) => batchRowRequestFingerprint("p", "row-1", target, "batch_image", "model", {}, sourceNode, nodes);
    const baseline = fingerprint(source);
    const changedRef = { ...reference, metadata: { ...reference.metadata, content: "image-v2" } };
    assert.notEqual(baseline, fingerprint(source, [target, changedRef, text, source]));
    const changedText = { ...text, metadata: { ...text.metadata, content: "red coat" } };
    assert.notEqual(baseline, fingerprint(source, [target, reference, changedText, source]));
    const changedPrompt: CanvasNodeData = { ...source, metadata: { ...source.metadata, batchTable: { ...source.metadata?.batchTable, globalPrompt: "changed" } } };
    assert.notEqual(baseline, fingerprint(changedPrompt));
});
