import { canvasPreconditionConflict, hashCanvasSnapshot, type CanvasSnapshot } from "./canvas-operation-contract";
import type { CanvasNodeData } from "@/types/canvas";

export type CanvasRuntimeRefs = {
    revision: number;
    stateHash: string;
};

export type CanvasToolPreconditionInput = {
    /** 冲刷尚未完成的状态同步，使本地 refs 追上运行时的权威 revision/stateHash。 */
    flushPendingStateSync: () => Promise<void>;
    /** 冲刷完成后重新读取 refs；调用方不要传入快照值，否则仍然会用到滞后数据。 */
    readRuntimeRefs: () => CanvasRuntimeRefs;
    expectedRevision: unknown;
    expectedStateHash: unknown;
};

/**
 * 页面侧只做快速前置检查，权威校验仍在本地运行时。运行时写回工具结果时会推进 revision，
 * 而页面 refs 只在下一次状态同步成功后更新；连续 MCP 写入因此会看到滞后的 revision/hash，
 * 被误判成“画布已变化”。先冲刷同步队列再比较，可避免这类假冲突。
 */
export async function canvasToolPreconditionConflict(input: CanvasToolPreconditionInput): Promise<"revision" | "state" | null> {
    // 同步失败不应让工具调用直接抛错：保持原有行为，由下面基于当前 refs 的比较给出结论。
    await input.flushPendingStateSync().catch(() => undefined);
    const refs = input.readRuntimeRefs();
    return canvasPreconditionConflict(input.expectedRevision, input.expectedStateHash, refs.revision, refs.stateHash);
}

const storyboardAgentTransientMetadataKeys = [
    "status", "taskStage", "taskProgress", "taskId", "taskStatus", "errorDetails", "composerContent", "taskClientOperationId",
    "taskProvider", "taskStartedAt", "taskCompletedAt", "taskDurationMs", "taskErrorCode", "taskOfficialStatus", "taskReceiptRecorded",
    "taskCreatedAt", "taskUpdatedAt", "retryOf", "attemptGroupId", "skillIds", "skillVersions", "skillFiles",
] as const;

/** Hash canvas state while ignoring only metadata fields the native AI storyboard submission itself mutates. */
export function hashCanvasSnapshotForStoryboardConfirmation(snapshot: CanvasSnapshot, scriptNodeId: string, baselineScript: CanvasNodeData): string {
    const baselineMetadata = baselineScript.metadata || {};
    const nodes = snapshot.nodes.map((node) => {
        if (node.id !== scriptNodeId) return node;
        const metadata: Record<string, unknown> = { ...(node.metadata || {}) };
        for (const key of storyboardAgentTransientMetadataKeys) {
            if (Object.hasOwn(baselineMetadata, key)) metadata[key] = baselineMetadata[key];
            else delete metadata[key];
        }
        return { ...node, updatedAt: baselineScript.updatedAt, metadata: metadata as CanvasNodeData["metadata"] };
    });
    return hashCanvasSnapshot({ ...snapshot, nodes });
}
