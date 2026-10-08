import type { CanvasNodeData } from "@/types/canvas";

/** Recovery follows the node's chosen task; history order must not choose its picture. */
export function generationTaskOwnsNode(node: CanvasNodeData, taskId: string) {
    if (node.metadata?.taskId) return node.metadata.taskId === taskId;
    return !node.metadata?.content && !node.metadata?.storageKey && !node.metadata?.assetId;
}

export function canBindProductionTaskSubmission(node: CanvasNodeData, taskId: string, idempotent?: boolean) {
    return !idempotent || generationTaskOwnsNode(node, taskId);
}
