import { describe, expect, test } from "bun:test";
import { createCanvasAgentImageOperations } from "../src/pages/canvas/canvas-agent-image-operations";
import { defaultConfig } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function fixture(failSubmission = 0) {
    let nodes: CanvasNodeData[] = [{ id: "source", type: CanvasNodeType.Image, title: "fixture", position: { x: 0, y: 0 }, width: 64, height: 64, metadata: { status: "success", content: "data:image/png;base64,fixture-only", naturalWidth: 64, naturalHeight: 64 } }];
    const calls: unknown[] = [];
    const api = createCanvasAgentImageOperations({
        projectId: "isolated-unit-fixture", getNodes: () => nodes, getConfig: () => defaultConfig, isReady: () => true,
        append: (_source, children) => { nodes.push(...children); },
        update: (id, patch) => { nodes = nodes.map((node) => node.id === id ? { ...node, metadata: { ...node.metadata, ...patch } } : node); },
        bindTask: (id, task) => { nodes = nodes.map((node) => node.id === id ? { ...node, metadata: { ...node.metadata, taskId: task.id, taskStatus: task.status, taskClientOperationId: task.clientOperationId } } : node); },
        persist: async () => new Map(), style: (_source, prompt) => ({ prompt, metadata: {} }),
        submitTask: async (input) => {
            calls.push(input);
            if (calls.length === failSubmission) throw new Error("fixture submission failure");
            return { id: `fixture-task-${calls.length}`, status: "queued", type: input.mode, prompt: input.prompt, clientOperationId: input.clientOperationId };
        },
    });
    return { api, calls, nodes: () => nodes };
}
const config = { model: "gpt-image-2" };

describe("image tool native submission logic (no provider/network)", () => {
    test("preflight validates inputs without mutating nodes or submitting", () => {
        const f = fixture();
        expect(f.api.preflight({ nodeId: "source", action: "mask", prompt: "fix", config, regions: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }] }).ready).toBe(true);
        expect(f.api.preflight({ nodeId: "source", action: "mask", prompt: "fix", config }).ready).toBe(false);
        expect(f.api.preflight({ nodeId: "source", action: "emotion", config }).ready).toBe(false);
        expect(f.calls).toHaveLength(0); expect(f.nodes()).toHaveLength(1);
    });
    test("editing short submits actual references, returns a task, and preserves source", async () => {
        const f = fixture(), original = JSON.stringify(f.nodes()[0]);
        const result = await f.api.edit({ nodeId: "source", action: "texture", config, clientOperationId: "fixture-edit" }, async () => {});
        expect(result.taskId).toBe("fixture-task-1"); expect(result.quality).toBe("uncertain");
        expect((f.calls[0] as { referenceImages: { id: string }[] }).referenceImages.map((item) => item.id)).toEqual(["source"]);
        expect(JSON.stringify(f.nodes()[0])).toBe(original);
        expect(f.nodes()[1].metadata?.composerContent).toContain("@[node:source]");
        const replay = await f.api.edit({ nodeId: "source", action: "texture", config, clientOperationId: "fixture-edit" }, async () => {});
        expect(replay.idempotentReplay).toBe(true); expect(f.calls).toHaveLength(1);
        await expect(f.api.edit({ nodeId: "source", action: "texture", config, prompt: "changed", clientOperationId: "fixture-edit" }, async () => {})).rejects.toThrow(/不同/);
    });
    test("source guard rejects before creating or submitting", async () => {
        const f = fixture();
        await expect(f.api.edit({ nodeId: "source", action: "texture", config, clientOperationId: "guard" }, async () => { throw new Error("stale"); })).rejects.toThrow("stale");
        expect(f.calls).toHaveLength(0); expect(f.nodes()).toHaveLength(1);
    });
    test("layers use independent stable task IDs and safe replay", async () => {
        const f = fixture(), input = { nodeId: "source", config, clientOperationId: "fixture-group", layers: [{ label: "主体", prompt: "只提取主体" }, { label: "背景", prompt: "只提取背景" }] };
        const first = await f.api.decompose(input, async () => {});
        expect(first.tasks).toHaveLength(2); expect(first.partial).toBe(false);
        expect(first.tasks[0].clientOperationId).not.toBe(first.tasks[1].clientOperationId);
        expect(f.nodes().slice(1).map((node) => node.metadata?.imageTool?.layerIndex)).toEqual([1, 2]);
        const replay = await f.api.decompose(input, async () => {});
        expect(f.calls).toHaveLength(2); expect(replay.paidRequestSubmitted).toBe(false);
    });
    test("partial submission reports accepted tasks and stops dispatching", async () => {
        const f = fixture(2);
        const result = await f.api.decompose({ nodeId: "source", config, clientOperationId: "partial", layers: [{ label: "a", prompt: "a" }, { label: "b", prompt: "b" }, { label: "c", prompt: "c" }] }, async () => {});
        expect(result.partial).toBe(true); expect(result.tasks).toHaveLength(1); expect(result.failures).toHaveLength(1); expect(f.calls).toHaveLength(2);
    });
});
