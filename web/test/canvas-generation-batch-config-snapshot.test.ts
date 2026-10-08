import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

const batchSource = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-generation-batches.ts"), "utf8");
const storyboardSource = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-storyboard.ts"), "utf8");

test("storyboard video batches pin their resolved settings and use the latest scheduler config", () => {
    expect(storyboardSource).toContain("const effectiveConfigRef = useRef(effectiveConfig)");
    expect(storyboardSource).toContain("pinCanvasVideoGenerationConfig(submissionConfig, configuredNode)");
    expect(storyboardSource).toContain("pinCanvasVideoGenerationConfig(submissionConfig, candidateVideoNode)");
    expect(batchSource).toContain("createBatchRowRequestFingerprint(projectId, target.rowId, node, generationMode, effectiveConfigRef.current");
    expect(batchSource).toContain("createBatchRowRequestFingerprint(projectId, item.rowId, node, generationMode, effectiveConfigRef.current");
    expect(batchSource).toContain("handleGenerateNodeRef.current(node.id, generationMode, prompt");
    expect(batchSource).toContain("currentNodes = nodesRef.current;");
});

test("keyframe storyboard generation keeps explicit settings from its existing video node", () => {
    expect(storyboardSource).toContain("model: existingMetadata.model || videoModel");
    expect(storyboardSource).toContain("size: existingMetadata.size || videoSize");
    expect(storyboardSource).toContain("vquality: existingMetadata.vquality || videoQuality");
});
