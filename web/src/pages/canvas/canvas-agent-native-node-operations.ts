import type { CanvasNodeData, CanvasNodeTypeId, Position } from "@/types/canvas";
import { listCreatableNodeDefinitions } from "@/lib/canvas/node-registry/node-registry";
import { isDrawingEngineAvailable } from "@/lib/canvas/canvas-drawing-engine";
import { CanvasNodeType } from "@/types/canvas";

export function assertNativeNodeMetadataAllowed(
    type: string,
    metadata: unknown,
    tldrawLicenseKey?: string,
    defaultDrawingEngine: "excalidraw" | "tldraw" = "excalidraw",
) {
    if (type !== CanvasNodeType.Drawing || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) return;
    const requestedEngine = (metadata as Record<string, unknown>).drawingEngine;
    if (requestedEngine !== undefined && requestedEngine !== "tldraw" && requestedEngine !== "excalidraw") {
        throw new Error("drawingEngine 必须是 excalidraw 或 tldraw");
    }
    if (requestedEngine === "tldraw" && !isDrawingEngineAvailable("tldraw", tldrawLicenseKey)) {
        throw new Error("当前便携版未配置有效的 tldraw License Key，不能创建 tldraw 绘图节点");
    }
    if ((requestedEngine === "tldraw" || requestedEngine === "excalidraw") && requestedEngine !== defaultDrawingEngine) {
        throw new Error(`请求的绘图引擎 ${requestedEngine} 与画布原生默认引擎 ${defaultDrawingEngine} 不一致，拒绝创建`);
    }
}

export type CanvasAgentCreatedNode = {
    nodeId: string;
    type: CanvasNodeTypeId;
    node: CanvasNodeData;
};

type Options = {
    nodesRef: { current: CanvasNodeData[] };
    getCanvasCenter: () => Position;
    createNode: (type: CanvasNodeTypeId, position?: Position, workflowProvider?: "runninghub") => void;
};

function cloneNode(node: CanvasNodeData): CanvasNodeData {
    return structuredClone(node);
}

export function createCanvasAgentNativeNodeOperations({ nodesRef, getCanvasCenter, createNode }: Options) {
    return {
        createNode(type: CanvasNodeTypeId, position?: Position, workflowProvider?: "runninghub"): CanvasAgentCreatedNode {
            if (typeof type !== "string" || !type.trim()) throw new Error("必须指定画布节点类型");
            const definition = listCreatableNodeDefinitions().find((item) => item.type === type);
            if (!definition) throw new Error(`页面未启用可创建的节点类型：${type}`);
            if (position && (!Number.isFinite(position.x) || !Number.isFinite(position.y))) throw new Error("节点位置必须是有限坐标");

            const beforeIds = new Set(nodesRef.current.map((node) => node.id));
            createNode(type, position || getCanvasCenter(), workflowProvider);

            const created = nodesRef.current.filter((node) => !beforeIds.has(node.id));
            if (created.length !== 1 || created[0].type !== type) {
                throw new Error(`原生节点创建未成功：${type}（绘图授权或节点插件可能不可用）`);
            }
            return { nodeId: created[0].id, type: created[0].type, node: cloneNode(created[0]) };
        },
    };
}

export type CanvasAgentNativeNodeOperations = ReturnType<typeof createCanvasAgentNativeNodeOperations>;
