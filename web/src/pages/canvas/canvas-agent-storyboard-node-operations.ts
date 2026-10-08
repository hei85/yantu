import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export type CanvasAgentStoryboardNodeResult = {
    nodeId: string;
    items: Array<{ rowId: string; nodeId: string; node: CanvasNodeData }>;
    nodeIds: string[];
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

export type CanvasAgentStoryboardGenerationResult = {
    nodeId: string;
    clientOperationId: string;
    status: "completed" | "running" | "failed" | "uncertain" | "cancelled";
    taskId?: string;
    rowIds: string[];
    rows: unknown[];
    revisionHint: string | null;
    confirmedQuote?: { model: string; expiresAt: string; options?: Record<string, unknown> };
    error?: string;
};

type Options = {
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    createScriptImageNodes: (nodeId: string, rowIds?: string[]) => void;
    createScriptVideoNodes: (nodeId: string, silent?: boolean, rowIds?: string[]) => void;
};

function validateRowIds(rowIds: string[]) {
    if (!Array.isArray(rowIds) || !rowIds.length || new Set(rowIds).size !== rowIds.length || rowIds.some((id) => typeof id !== "string" || !id.trim())) {
        throw new Error("rowIds 必须是非空且不重复的明确分镜行 ID 列表");
    }
}

export function createCanvasAgentStoryboardNodeOperations({ nodesRef, connectionsRef, createScriptImageNodes, createScriptVideoNodes }: Options) {
    function readRows(nodeId: string, rowIds: string[], field: "imageGenerationPrompt" | "videoMotionPrompt") {
        if (!nodeId?.trim()) throw new Error("必须指定真实分镜脚本节点 ID");
        validateRowIds(rowIds);
        const scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        if (!scriptNode) throw new Error(`分镜脚本节点不存在：${nodeId}`);
        const rows = scriptNode.metadata?.storyboard?.rows || [];
        return rowIds.map((id) => {
            const row = rows.find((item) => item.id === id);
            if (!row) throw new Error(`分镜行不存在：${id}`);
            const prompt = (row[field] || row.plotDescription).trim();
            if (!prompt) throw new Error(`分镜行缺少${field === "imageGenerationPrompt" ? "画面" : "视频"}描述：${id}`);
            return row;
        });
    }

    function readback(nodeId: string, rows: Array<{ id: string; imageNodeId?: string; videoNodeId?: string }>, mediaType: "image" | "video"): CanvasAgentStoryboardNodeResult {
        const currentScript = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        const items = rows.map((row) => {
            const currentRow = currentScript?.metadata?.storyboard?.rows.find((item) => item.id === row.id);
            const mediaNodeId = mediaType === "image" ? currentRow?.imageNodeId : currentRow?.videoNodeId;
            const mediaNode = mediaNodeId ? nodesRef.current.find((node) => node.id === mediaNodeId && node.type === (mediaType === "image" ? CanvasNodeType.Image : CanvasNodeType.Video)) : undefined;
            if (!currentRow || !mediaNode) throw new Error(`未能为分镜行创建${mediaType === "image" ? "图片" : "视频"}节点：${row.id}`);
            return { rowId: row.id, nodeId: mediaNode.id, node: structuredClone(mediaNode) };
        });
        return {
            nodeId,
            items,
            nodeIds: items.map((item) => item.nodeId),
            nodes: nodesRef.current.map((node) => structuredClone(node)),
            connections: connectionsRef.current.map((connection) => structuredClone(connection)),
        };
    }

    return {
        createImageNodes(input: { nodeId: string; rowIds: string[] }) {
            const rows = readRows(input.nodeId, input.rowIds, "imageGenerationPrompt");
            createScriptImageNodes(input.nodeId, rows.map((row) => row.id));
            return readback(input.nodeId, rows, "image");
        },
        createVideoNodes(input: { nodeId: string; rowIds: string[] }) {
            const rows = readRows(input.nodeId, input.rowIds, "videoMotionPrompt");
            createScriptVideoNodes(input.nodeId, true, rows.map((row) => row.id));
            return readback(input.nodeId, rows, "video");
        },
    };
}

export type CanvasAgentStoryboardNodeOperations = ReturnType<typeof createCanvasAgentStoryboardNodeOperations>;
