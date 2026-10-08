import { nanoid } from "nanoid";
import { creationRuns, type CreationSubmission } from "./api/creation-runs";
import type { CreateTaskInput } from "./api/task-center";

// Both the node composer and Agent submit the same confirmed professional task.
export async function submitStoryboardTask(request: CreateTaskInput, options: {
    signal: AbortSignal;
    assertCurrent: () => void;
    confirm: (submission: CreationSubmission) => Promise<boolean>;
    /** Stable identity supplied by retryable callers such as MCP. */
    clientOperationId?: string;
}, api = creationRuns) {
    const { signal, assertCurrent } = options;
    const clientOperationId = options.clientOperationId?.trim();
    if (options.clientOperationId !== undefined && (!clientOperationId || clientOperationId.length > 109)) {
        throw new Error("clientOperationId 必须为 1 到 109 个字符，拆镜任务未提交");
    }
    const clientKey = clientOperationId ? `storyboard:${clientOperationId}` : `storyboard:${nanoid()}`;
    const apiCall = async <T>(operation: () => Promise<T>): Promise<T> => {
        try { return await operation(); }
        catch (cause) {
            if (clientOperationId) throw new StoryboardSubmissionUncertainError(clientOperationId, cause);
            throw cause;
        }
    };
    const detail = await apiCall(() => api.create({ clientKey, canvasId: request.projectId, state: { kind: "storyboard" } }, signal));
    const run = await apiCall(() => api.claim(detail.run.id, { expectedEpoch: detail.run.executionEpoch, owner: `storyboard:${nanoid()}` }, signal));
    const guard = { executionEpoch: run.executionEpoch, owner: run.executionOwner };
    let connectionError: unknown;
    const heartbeat = setInterval(() => {
        void api.heartbeat(run.id, guard, signal).catch((error) => { connectionError = error; });
    }, 15_000);
    try {
        const submission = await apiCall(() => api.prepare(run.id, { ...guard, itemKey: "storyboard", request }, signal));
        if (!await options.confirm(submission)) return undefined;
        signal.throwIfAborted();
        if (connectionError) await apiCall(() => Promise.reject(connectionError));
        assertCurrent();
        if (Date.parse(submission.quote.expiresAt) <= Date.now()) throw new Error("分镜方案已过期，请重新发起拆镜并确认最新方案");
        const approved = await apiCall(() => api.approve(run.id, { ...guard, submissionIds: [submission.id] }, signal));
        if (!approved.submissions.some((item) => item.id === submission.id && item.approvedAt)) throw new Error("执行确认回执不完整，尚未提交拆镜任务");
        signal.throwIfAborted();
        assertCurrent();
        return await apiCall(() => api.execute(run.id, { ...guard, submissionId: submission.id }, signal));
    } finally {
        clearInterval(heartbeat);
        void api.release(run.id, guard).catch(() => { /* Offline leases expire on the server. */ });
    }
}

/** The server may have completed this call; retry with the same ID to recover its run/submission/task. */
export class StoryboardSubmissionUncertainError extends Error {
    readonly uncertain = true;
    constructor(readonly clientOperationId: string, cause: unknown) {
        super(`拆镜提交状态不确定。请用相同 clientOperationId（${clientOperationId}）重试以恢复原任务，不要更换 ID。`, { cause });
        this.name = "StoryboardSubmissionUncertainError";
    }
}
