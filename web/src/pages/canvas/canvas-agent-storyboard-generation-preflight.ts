import { CanvasNodeType, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";

export type StoryboardMediaKind = "image" | "video";
export type StoryboardMediaRowStatus = "ready" | "completed" | "running" | "blocked";
export type CanvasAgentStoryboardMediaPreflightInput = { nodeId: string; kind: StoryboardMediaKind; rowIds: string[] };
export type CanvasAgentStoryboardMediaGenerationInput = CanvasAgentStoryboardMediaPreflightInput & { clientOperationId: string };

export type CanvasAgentStoryboardMediaPreflightResult = {
    nodeId: string;
    kind: StoryboardMediaKind;
    model: string;
    status: "ready" | "running" | "blocked";
    rows: StoryboardMediaRowPreflight[];
    submitted: false;
    reason?: string;
};

export type CanvasAgentStoryboardMediaGenerationResult = {
    nodeId: string;
    kind: StoryboardMediaKind;
    clientOperationId: string;
    batchId?: string;
    status: "queued" | "partial" | "running" | "completed" | "blocked" | "cancelled" | "uncertain" | "failed";
    submitted: boolean;
    confirmation?: { method: "native-generation-confirmation"; model: string; taskCount: number; confirmed: boolean };
    rows: Array<Omit<StoryboardMediaRowPreflight, "status"> & { clientOperationId?: string; status: StoryboardMediaRowStatus | "waiting" | "submitting" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "uncertain" }>;
};

export type StoryboardMediaRowPreflight = {
    rowId: string;
    nodeId?: string;
    taskId?: string;
    status: StoryboardMediaRowStatus;
    prompt: string;
    assetNodeIds: string[];
    reason?: string;
};

export function preflightStoryboardMediaRows(input: {
    rows: StoryboardRow[];
    nodes: CanvasNodeData[];
    rowIds: string[];
    kind: StoryboardMediaKind;
    modelReady: boolean;
    idempotentSubmissionAvailable: boolean;
    allowMissingMediaNode?: boolean;
    assetNodeIdsByRow?: Record<string, string[]>;
}): StoryboardMediaRowPreflight[] {
    const { rows, nodes, rowIds, kind } = input;
    if (!Array.isArray(rowIds) || rowIds.length === 0 || rowIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(rowIds).size !== rowIds.length) {
        throw new Error("rowIds 必须是非空且不重复的明确分镜行 ID 列表");
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return rowIds.map((rowId) => {
        const row = byId.get(rowId);
        if (!row) throw new Error(`分镜行不存在：${rowId}`);
        const prompt = (kind === "image" ? row.imageGenerationPrompt || row.plotDescription : row.videoMotionPrompt || row.plotDescription).trim();
        const assetNodeIds = input.assetNodeIdsByRow?.[rowId] || [];
        const mediaNodeId = kind === "image" ? row.imageNodeId : row.videoNodeId;
        const mediaNode = mediaNodeId ? nodeById.get(mediaNodeId) : undefined;
        if (!prompt) return { rowId, ...(mediaNode ? { nodeId: mediaNode.id } : {}), ...(mediaNode?.metadata?.taskId ? { taskId: mediaNode.metadata.taskId } : {}), status: "blocked", prompt, assetNodeIds, reason: "缺少生成提示词" };
        if (mediaNode?.type !== (kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Video)) {
            if (!input.allowMissingMediaNode) return { rowId, status: "blocked", prompt, assetNodeIds, reason: "媒体节点不存在；请先创建对应的图片或视频节点" };
            if (!input.modelReady) return { rowId, status: "blocked", prompt, assetNodeIds, reason: "模型配置未就绪" };
            if (!input.idempotentSubmissionAvailable) return { rowId, status: "blocked", prompt, assetNodeIds, reason: "当前分镜批次提交未能为每行绑定稳定 clientOperationId；暂不提交收费任务" };
            return { rowId, status: "ready", prompt, assetNodeIds };
        }
        if (mediaNode.metadata?.content) return { rowId, nodeId: mediaNode.id, ...(mediaNode.metadata.taskId ? { taskId: mediaNode.metadata.taskId } : {}), status: "completed", prompt, assetNodeIds };
        if (mediaNode.metadata?.taskId || mediaNode.metadata?.status === "loading" || mediaNode.metadata?.taskStatus === "queued" || mediaNode.metadata?.taskStatus === "running") {
            return { rowId, nodeId: mediaNode.id, ...(mediaNode.metadata.taskId ? { taskId: mediaNode.metadata.taskId } : {}), status: "running", prompt, assetNodeIds, reason: mediaNode.metadata.taskId ? "已有任务正在处理" : "节点处于生成中但尚无 taskId" };
        }
        if (!input.modelReady) return { rowId, nodeId: mediaNode.id, status: "blocked", prompt, assetNodeIds, reason: "模型配置未就绪" };
        if (!input.idempotentSubmissionAvailable) {
            return { rowId, nodeId: mediaNode.id, status: "blocked", prompt, assetNodeIds, reason: "当前分镜批次提交未能为每行绑定稳定 clientOperationId；暂不提交收费任务" };
        }
        return { rowId, nodeId: mediaNode.id, status: "ready", prompt, assetNodeIds };
    });
}
