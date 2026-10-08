import { batchPromptForRow } from "@/lib/canvas/canvas-batch-table";
import { CanvasNodeType, type CanvasBatchRow, type CanvasBatchTableData, type CanvasNodeData } from "@/types/canvas";

export type CanvasAgentBatchRowStatus = "ready" | "completed" | "running" | "blocked";
export type CanvasAgentBatchRowPreflight = { rowId: string; nodeId?: string; taskId?: string; status: CanvasAgentBatchRowStatus; prompt: string; assetNodeIds: string[]; reason?: string };

export function preflightBatchTableRows(input: { table: CanvasBatchTableData; nodes: CanvasNodeData[]; rowIds: string[]; activeNodeIds?: string[]; modelReady: boolean }): CanvasAgentBatchRowPreflight[] {
    const { table, nodes, rowIds } = input;
    if (!Array.isArray(rowIds) || rowIds.length === 0 || rowIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(rowIds).size !== rowIds.length) throw new Error("rowIds 必须是非空且不重复的明确批量行 ID 列表");
    const rows = new Map<string, CanvasBatchRow>(table.rows.map((row) => [row.id, row]));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const active = new Set(input.activeNodeIds || []);
    return rowIds.map((rowId) => {
        const row = rows.get(rowId);
        if (!row) throw new Error(`批量行不存在：${rowId}`);
        const prompt = batchPromptForRow(table, row).trim();
        const assetNodeIds = row.inputNodeIds.filter(Boolean);
        const output = row.outputNodeId ? nodeById.get(row.outputNodeId) : undefined;
        if (!prompt) return { rowId, ...(output ? { nodeId: output.id } : {}), ...(output?.metadata?.taskId ? { taskId: output.metadata.taskId } : {}), status: "blocked", prompt, assetNodeIds, reason: "缺少生成提示词" };
        if (!row.enabled) return { rowId, ...(output ? { nodeId: output.id } : {}), status: "blocked", prompt, assetNodeIds, reason: "该行已停用" };
        if (table.operation === "try_on" && assetNodeIds.length < 2) return { rowId, ...(output ? { nodeId: output.id } : {}), status: "blocked", prompt, assetNodeIds, reason: "换装任务缺少人物图或服装图" };
        const validAssets = assetNodeIds.filter((id) => { const node = nodeById.get(id); return node?.type === CanvasNodeType.Image && Boolean(node.metadata?.content || node.metadata?.storageKey); });
        if (validAssets.length !== assetNodeIds.length || assetNodeIds.length === 0) return { rowId, ...(output ? { nodeId: output.id } : {}), status: "blocked", prompt, assetNodeIds, reason: "缺少参考图" };
        if (output && active.has(output.id)) return { rowId, nodeId: output.id, ...(output.metadata?.taskId ? { taskId: output.metadata.taskId } : {}), status: "running", prompt, assetNodeIds, reason: "已有任务正在处理" };
        if (output?.metadata?.content) return { rowId, nodeId: output.id, ...(output.metadata.taskId ? { taskId: output.metadata.taskId } : {}), status: "completed", prompt, assetNodeIds };
        if (!input.modelReady) return { rowId, ...(output ? { nodeId: output.id } : {}), status: "blocked", prompt, assetNodeIds, reason: "模型配置未就绪" };
        return { rowId, ...(output ? { nodeId: output.id } : {}), status: "ready", prompt, assetNodeIds };
    });
}
