import assert from "node:assert/strict";
import { test } from "node:test";

import { findCanvasAgentAvailableAssets } from "../src/pages/canvas/canvas-agent-available-assets";
import type { ProjectAsset } from "../src/services/api/projects";
import type { Asset } from "../src/stores/use-asset-store";

const localAssets = [
    { id: "local-text", kind: "text", title: "旁白草稿", category: "script", status: "draft", coverUrl: "secret-url", tags: ["voice"], createdAt: "", updatedAt: "", data: { content: "text" } },
    { id: "local-image", kind: "image", title: "场景参考", category: "scene", status: "confirmed", coverUrl: "secret-url", tags: [], createdAt: "", updatedAt: "", data: { dataUrl: "secret-url", width: 10, height: 10, bytes: 1, mimeType: "image/png" } },
    { id: "local-model", kind: "model", title: "隐藏模型", category: "prop", coverUrl: "secret-url", tags: [], createdAt: "", updatedAt: "", data: { url: "secret-url", bytes: 1, mimeType: "model/gltf-binary", fileName: "model" } },
] as unknown as Asset[];

const projectAssets = [
    { id: "shared-id", title: "海边镜头", mediaType: "video", category: "scene", status: "confirmed", storageKey: "resource:resource-1", versionCount: 1, usages: [], position: 0, updatedAt: "" },
] as unknown as ProjectAsset[];

test("available assets query merges local and linked project assets into safe summaries", () => {
    const result = findCanvasAgentAvailableAssets({}, localAssets, projectAssets);
    assert.equal(result.total, 3);
    assert.deepEqual(result.assets.map((item) => item.assetId), ["local-text", "local-image", "shared-id"]);
    assert.equal(result.assets[2].source, "project");
    assert.equal(result.assets[2].ready, true);
    assert.deepEqual(Object.keys(result.assets[0]).sort(), ["assetId", "category", "kind", "ready", "source", "status", "title"]);
    assert.equal(JSON.stringify(result).includes("secret-url"), false);
});

test("available assets query filters by title/kind and clamps result limits", () => {
    const filtered = findCanvasAgentAvailableAssets({ query: "海边", kind: "video", limit: 0 }, localAssets, projectAssets);
    assert.equal(filtered.total, 1);
    assert.equal(filtered.limit, 1);
    assert.equal(filtered.assets[0].assetId, "shared-id");
    const capped = findCanvasAgentAvailableAssets({ limit: 1000 }, localAssets, projectAssets);
    assert.equal(capped.limit, 100);
});
