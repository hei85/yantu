import { describe, expect, test } from "bun:test";

import { applyGeneratedMediaResultMetadata, applyGenerationTaskResultToNodes, applyMaterializedGenerationTaskResultToNodes, buildGenerationTaskNodeResult, videoMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import type { GenerationTask } from "@/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function videoNode(assetId: string, storageKey: string): CanvasNodeData {
    return {
        id: "node-1",
        type: CanvasNodeType.Video,
        title: "镜头",
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: { assetId, storageKey, content: "https://example.test/old.mp4", prompt: "旧提示词" },
    };
}

describe("applyGeneratedMediaResultMetadata", () => {
    test("clears the previous asset binding when a regenerated media result lands", () => {
        const node = videoNode("asset-old", "video:old");
        const next = applyGeneratedMediaResultMetadata(node, videoMetadata({
            url: "https://example.test/new.mp4",
            storageKey: "video:new",
            width: 1280,
            height: 720,
            bytes: 12,
            mimeType: "video/mp4",
            durationMs: 4000,
        }), { prompt: "新提示词" });

        expect(next.assetId).toBeUndefined();
        expect(next.storageKey).toBe("video:new");
        expect(next.content).toBe("https://example.test/new.mp4");
        expect(next.prompt).toBe("新提示词");
        expect(next.status).toBe("success");
        expect(next.vquality).toBe("720p");
    });

    test("rehydrates a recovered video task that returns a resource reference without a data URL", async () => {
        const node = videoNode("asset-old", "video:old");
        const recovered = await buildGenerationTaskNodeResult(node, {
            id: "task-recovered",
            type: "canvas_video",
            status: "succeeded",
            prompt: "雨后街道上的黄色小车",
            attempts: 1,
            createdAt: "2026-09-24T00:00:00.000Z",
            inputJson: JSON.stringify({ mode: "video", metadata: { nodeId: node.id } }),
            resultJson: JSON.stringify({
                mode: "video",
                video: {
                    resourceId: "resource-recovered",
                    storageKey: "resource:resource-recovered",
                    mimeType: "video/mp4",
                    width: 1280,
                    height: 736,
                    durationMs: 13667,
                },
            }),
        });

        expect(recovered.metadata.status).toBe("success");
        expect(recovered.metadata.taskId).toBe("task-recovered");
        expect(recovered.metadata.storageKey).toBe("resource:resource-recovered");
        expect(recovered.metadata.content).toContain("/resources/resource-recovered/file");
        expect(recovered.metadata.naturalWidth).toBe(1280);
        expect(recovered.metadata.naturalHeight).toBe(736);
        expect(recovered.metadata.durationMs).toBe(13667);
    });

    test("rehydrates audio format mismatch evidence for the player to report", async () => {
        const node: CanvasNodeData = {
            id: "audio-node-1",
            type: CanvasNodeType.Audio,
            title: "旁白",
            position: { x: 0, y: 0 },
            width: 340,
            height: 120,
            metadata: { audioFormat: "mp3", status: "loading" },
        };
        const recovered = await buildGenerationTaskNodeResult(node, {
            id: "audio-task-recovered",
            type: "canvas_audio",
            status: "succeeded",
            prompt: "清晰的中文旁白",
            attempts: 1,
            createdAt: "2026-09-24T00:00:00.000Z",
            inputJson: JSON.stringify({ mode: "audio", metadata: { nodeId: node.id } }),
            resultJson: JSON.stringify({
                mode: "audio",
                audio: {
                    resourceId: "audio-resource-recovered",
                    storageKey: "resource:audio-resource-recovered",
                    mimeType: "audio/wav",
                    format: "wav",
                    actualFormat: "wav",
                    requestedFormat: "mp3",
                    durationMs: 2400,
                },
            }),
        });

        expect(recovered.metadata.status).toBe("success");
        expect(recovered.metadata.taskId).toBe("audio-task-recovered");
        expect(recovered.metadata.storageKey).toBe("resource:audio-resource-recovered");
        expect(recovered.metadata.mimeType).toBe("audio/wav");
        expect(recovered.metadata.audioRequestedFormat).toBe("mp3");
        expect(recovered.metadata.audioActualFormat).toBe("wav");
    });
});

describe("historical generation result recovery", () => {
    const oldTask: GenerationTask = {
        id: "old-task", type: "canvas_video", status: "succeeded", prompt: "old prompt", attempts: 1,
        createdAt: "2026-10-02T00:00:00.000Z",
        inputJson: JSON.stringify({ mode: "video", metadata: { nodeId: "node-1" } }),
        resultJson: JSON.stringify({ mode: "video", video: { resourceId: "old-result", storageKey: "resource:old-result", mimeType: "video/mp4" } }),
    };

    test("raw recovery preserves the selected new task and its media", async () => {
        const node = videoNode("adopted-asset", "resource:adopted");
        node.metadata = { ...node.metadata, taskId: "new-task" };
        const nodes = [node];
        const result = await applyGenerationTaskResultToNodes(nodes, oldTask);
        expect(result.updated).toBe(false);
        expect(result.superseded).toBe(true);
        expect(result.nodes).toBe(nodes);
        expect(result.node?.metadata?.storageKey).toBe("resource:adopted");
    });

    test("materialized recovery rejects the old task before looking up its old asset", async () => {
        const node = videoNode("adopted-asset", "resource:adopted");
        node.metadata = { ...node.metadata, taskId: "new-task" };
        const result = await applyMaterializedGenerationTaskResultToNodes([node], oldTask,
            { outputIndex: 0, mediaType: "video", materializedAssetId: "missing-old-asset" }, "attach-node:old-task:0");
        expect(result.updated).toBe(false);
        expect(result.superseded).toBe(true);
        expect(result.node).toBe(node);
    });

    test("manual media replacement stays selected during task recovery", async () => {
        const node = videoNode("manually-selected", "resource:adopted");
        const result = await applyGenerationTaskResultToNodes([node], oldTask);
        expect(result.updated).toBe(false);
        expect(result.superseded).toBe(true);
    });

    test("an explicit missing target must not fall back to another task-bound node", async () => {
        const node = videoNode("asset-old", "video:old");
        node.metadata = { ...node.metadata, taskId: oldTask.id };
        const result = await applyGenerationTaskResultToNodes([node], oldTask, "deleted-target");
        expect(result.updated).toBe(false);
        expect(result.node).toBeNull();
    });

    test("the active task still recovers its completed media", async () => {
        const node = videoNode("asset-old", "video:old");
        node.metadata = { ...node.metadata, taskId: oldTask.id };
        const result = await applyGenerationTaskResultToNodes([node], oldTask);
        expect(result.updated).toBe(true);
        expect(result.node?.metadata?.taskId).toBe(oldTask.id);
        expect(result.node?.metadata?.storageKey).toBe("resource:old-result");
    });
});
