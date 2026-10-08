import { describe, expect, test } from "bun:test";

import { canvasGenerationPromptMetadata, canvasGenerationRequestFingerprint, runCanvasGenerationSubmissionOnce } from "@/lib/canvas/canvas-generation-submission";
import { generationClientOperationIdForIndex } from "@/lib/canvas/canvas-project-generation";
import { waitForCanvasGenerationSubmission } from "@/lib/canvas/canvas-agent-generation-wait";
import { runCanvasGenerationOps } from "@/pages/canvas/use-canvas-operation-history";
import type { GenerationTask } from "@/services/api/task-center";

function fingerprint(overrides: Partial<Parameters<typeof canvasGenerationRequestFingerprint>[0]> = {}) {
    return canvasGenerationRequestFingerprint({
        nodeId: "node-1",
        mode: "video",
        prompt: "夜晚的城市",
        model: "video-model",
        options: { size: "16:9", videoSeconds: 10, vquality: "768p" },
        context: {
            referenceImages: [{ id: "image-1", name: "reference.png", type: "image/png", dataUrl: "", storageKey: "resource:image-1" }],
            referenceVideos: [],
            referenceAudios: [],
            characterReferences: [],
            resolvedCharacterVersions: [],
            resolvedCharacterVoices: [],
        },
        ...overrides,
    });
}

describe("canvas generation submission", () => {
    test("one MCP operation id fans out to distinct stable ids for batch outputs", () => {
        const id = "canvas:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        expect(generationClientOperationIdForIndex(id, 0, 2)).toBe(`${id}:1`);
        expect(generationClientOperationIdForIndex(id, 1, 2)).toBe(`${id}:2`);
        expect(generationClientOperationIdForIndex(id, 0, 1)).toBe(id);
    });
    test("持久化时分离编辑器槽位提示词和模型提示词", () => {
        expect(canvasGenerationPromptMetadata("自我介绍 @图片1", "电影感：自我介绍 @图片1")).toEqual({
            composerContent: "自我介绍 @图片1",
            prompt: "电影感：自我介绍 @图片1",
        });
    });

    test("同一节点的并发提交只执行一次", async () => {
        const locks = new Map<string, Promise<unknown>>();
        let executions = 0;
        let duplicates = 0;
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const run = () =>
            runCanvasGenerationSubmissionOnce(
                locks,
                "node-1",
                async () => {
                    executions += 1;
                    await pending;
                    return "done";
                },
                () => {
                    duplicates += 1;
                },
            );

        const submissions = [run(), run(), run()];
        await Promise.resolve();
        expect(executions).toBe(1);
        expect(duplicates).toBe(2);
        release();
        expect(await Promise.all(submissions)).toEqual(["done", "done", "done"]);

        await run();
        expect(executions).toBe(2);
    });

    test("相同输入生成稳定指纹，关键内容变化会改变指纹", () => {
        expect(fingerprint({ options: { vquality: "768p", videoSeconds: 10, size: "16:9" } })).toBe(fingerprint());
        expect(fingerprint({ prompt: "白天的城市" })).not.toBe(fingerprint());
        expect(fingerprint({ model: "another-model" })).not.toBe(fingerprint());
        expect(fingerprint({ options: { size: "9:16", videoSeconds: 10, vquality: "768p" } })).not.toBe(fingerprint());
        expect(
            fingerprint({
                context: {
                    referenceImages: [{ id: "image-2", name: "other.png", type: "image/png", dataUrl: "", storageKey: "resource:image-2" }],
                    referenceVideos: [],
                    referenceAudios: [],
                    characterReferences: [],
                    resolvedCharacterVersions: [],
                    resolvedCharacterVoices: [],
                },
            }),
        ).not.toBe(fingerprint());
    });

    test("local bridge returns task acceptance while provider work remains pending", async () => {
        let finishGeneration!: () => void;
        let generationFinished = false;
        const generation = new Promise<void>((resolve) => {
            finishGeneration = () => {
                generationFinished = true;
                resolve();
            };
        });
        const submitted = Promise.resolve({ taskId: "task-1", status: "running" });
        const result = await Promise.race([
            waitForCanvasGenerationSubmission(generation, submitted),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("submission handshake waited for provider completion")), 100)),
        ]);

        expect(result).toEqual({ kind: "submitted", value: { taskId: "task-1", status: "running" } });
        expect(generationFinished).toBe(false);
        finishGeneration();
    });

    test("canvas_apply_ops generation returns a traceable task before the provider finishes", async () => {
        const task: GenerationTask = {
            id: "task-local-1",
            type: "canvas_video",
            status: "running",
            prompt: "5-second fixture clip",
            attempts: 1,
            createdAt: "2026-09-23T00:00:00.000Z",
            updatedAt: "2026-09-23T00:00:00.000Z",
            clientContext: { nodeId: "video-node-1" },
        };
        let finishGeneration!: () => void;
        let generationFinished = false;
        let clientOperationId = "";
        const pendingGeneration = new Promise<void>((resolve) => {
            finishGeneration = () => {
                generationFinished = true;
                resolve();
            };
        });
        const accepted = await runCanvasGenerationOps({
            generationOps: [{ type: "run_generation", nodeId: "video-node-1", mode: "video", prompt: task.prompt, clientOperationId: "canvas:test-operation-0001" }],
            nodes: [],
            context: { source: "local" },
            generate: async (_nodeId, _mode, _prompt, options) => {
                clientOperationId = options.clientOperationId || "";
                options.onTaskUpdate?.(task);
                await pendingGeneration;
            },
            subscribeTasks: () => () => undefined,
            consumeTask: async () => undefined,
            resumeAgent: async () => undefined,
        });

        expect(accepted).toEqual([{ operationNodeId: "video-node-1", task }]);
        expect(clientOperationId).toBe("canvas:test-operation-0001");
        expect(generationFinished).toBe(false);
        finishGeneration();
        await pendingGeneration;
    });

    test("generation errors before task acceptance remain visible to the MCP caller", async () => {
        const failure = new Error("task creation failed");
        await expect(waitForCanvasGenerationSubmission(Promise.reject(failure), new Promise(() => undefined))).rejects.toBe(failure);
    });
});
