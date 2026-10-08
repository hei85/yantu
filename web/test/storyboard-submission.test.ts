import { expect, test } from "bun:test";
import { creationRuns, type CreationRun, type CreationSubmission } from "../src/services/api/creation-runs";
import { submitStoryboardTask } from "../src/services/storyboard-submission";
import type { CreateTaskInput, GenerationTask } from "../src/services/api/task-center";

const request = { type: "canvas_text", operation: "storyboard", projectId: "canvas", prompt: "剧本" } as CreateTaskInput;
function harness(expiresAt = "2099-01-01") {
    const calls: string[] = [];
    const run = { id: "run", executionEpoch: 1, executionOwner: "owner" } as CreationRun;
    const submission = { id: "quote", quote: { expiresAt } } as CreationSubmission;
    const api = {
        ...creationRuns,
        create: async () => ({ run, submissions: [] }), claim: async () => run,
        prepare: async () => { calls.push("prepare"); return submission; },
        approve: async () => { calls.push("approve"); return { submissions: [{ ...submission, approvedAt: "now" }] }; },
        execute: async () => { calls.push("execute"); return { id: "task" } as GenerationTask; },
        release: async () => { calls.push("release"); return { released: true }; },
    } as typeof creationRuns;
    return { api, calls };
}

test("取消专业拆镜费用确认不会批准或提交任务", async () => {
    const h = harness();
    expect(await submitStoryboardTask(request, { signal: new AbortController().signal, assertCurrent() {}, confirm: async () => false }, h.api)).toBeUndefined();
    expect(h.calls).toEqual(["prepare", "release"]);
});
test("确认后提交原报价对应的专业任务", async () => {
    const h = harness();
    expect((await submitStoryboardTask(request, { signal: new AbortController().signal, assertCurrent() {}, confirm: async () => true }, h.api))?.id).toBe("task");
    expect(h.calls).toEqual(["prepare", "approve", "execute", "release"]);
});
test("过期报价或确认期间编辑分镜均阻止提交", async () => {
    for (const changed of [false, true]) {
        const h = harness(changed ? "2099-01-01" : "2000-01-01");
        await expect(submitStoryboardTask(request, { signal: new AbortController().signal, assertCurrent() { if (changed) throw new Error("分镜已编辑"); }, confirm: async () => true }, h.api)).rejects.toThrow();
        expect(h.calls).toEqual(["prepare", "release"]);
    }
});

const retrySubmission: CreationSubmission = {
    id: "submission-1", runId: "run-1", itemKey: "storyboard", requestHash: "hash",
    quote: { model: "model", expiresAt: "2099-01-01T00:00:00Z", quoteHash: "quote" },
};

test("MCP 重试用同一 clientOperationId 恢复原 run 和 submission，并仍逐次经过费用确认", async () => {
    const run: CreationRun = { id: "run-1", userId: "user", revision: 1, executionEpoch: 0, executionOwner: "", status: "idle", state: { kind: "storyboard" }, createdAt: "", updatedAt: "" };
    const clientKeys: string[] = [], confirmed: string[] = [], executed: string[] = [];
    const api = {
        ...creationRuns,
        create: async (input: { clientKey: string }) => { clientKeys.push(input.clientKey); return { run, submissions: [retrySubmission] }; },
        claim: async () => ({ ...run, executionEpoch: 1, executionOwner: "owner" }),
        heartbeat: async () => ({ leaseExpiresAt: "2099-01-01" }), release: async () => ({ released: true }),
        prepare: async () => retrySubmission,
        approve: async () => ({ submissions: [{ ...retrySubmission, approvedAt: "2026-09-28" }] }),
        execute: async () => { executed.push(retrySubmission.id); return { id: "task-1" } as GenerationTask; },
    } as typeof creationRuns;
    const invoke = () => submitStoryboardTask(request, {
        signal: new AbortController().signal,
        assertCurrent: () => {},
        confirm: async (item) => { confirmed.push(item.id); return true; },
        clientOperationId: "mcp-op-123",
    }, api);

    expect((await invoke())?.id).toBe("task-1");
    expect((await invoke())?.id).toBe("task-1");
    expect(clientKeys).toEqual(["storyboard:mcp-op-123", "storyboard:mcp-op-123"]);
    expect(confirmed).toEqual(["submission-1", "submission-1"]);
    expect(executed).toEqual(["submission-1", "submission-1"]);
});

test("稳定身份下网络失败会标记 uncertain 并提示使用同一 ID 恢复", async () => {
    const api = { ...creationRuns, create: async () => { throw new Error("timeout"); } } as typeof creationRuns;
    await expect(submitStoryboardTask(request, {
        signal: new AbortController().signal,
        assertCurrent: () => {},
        confirm: async () => true,
        clientOperationId: "mcp-op-uncertain",
    }, api)).rejects.toMatchObject({
        name: "StoryboardSubmissionUncertainError",
        uncertain: true,
        clientOperationId: "mcp-op-uncertain",
        message: expect.stringContaining("用相同 clientOperationId"),
    });
});
