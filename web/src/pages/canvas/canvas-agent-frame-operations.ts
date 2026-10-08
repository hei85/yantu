import { applyFrameDrop, canFolderContain, canFrameContain, canLinkedFolderArchive, isCanvasFolderNode, isFrameNode } from "@/lib/canvas/canvas-frame";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { isHiddenBatchChild } from "@/lib/canvas/canvas-project-domain";

export type CanvasAgentFrameMutation = {
    changedNodeIds: string[];
    nodes: CanvasNodeData[];
    createdFrame?: CanvasNodeData;
};

type Options = {
    nodesRef: { current: CanvasNodeData[] };
    createFolder: () => void;
    createStoryboardGroup: (nodeIds?: string[]) => void;
    createReferenceGroup: (nodeIds?: string[]) => void;
    commitNodes: (nodes: CanvasNodeData[]) => void;
    archiveNodesToLinkedFolder?: (folderNodeId: string, nodes: CanvasNodeData[]) => Promise<void>;
};

function requireIds(nodeIds: string[]) {
    if (!Array.isArray(nodeIds) || nodeIds.length === 0 || nodeIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(nodeIds).size !== nodeIds.length) {
        throw new Error("nodeIds 必须是非空且不重复的明确节点 ID 列表");
    }
}

function requireExistingUnlocked(nodes: CanvasNodeData[], nodeIds: string[]) {
    requireIds(nodeIds);
    const selected = nodeIds.map((id) => {
        const node = nodes.find((candidate) => candidate.id === id);
        if (!node) throw new Error(`画布节点不存在：${id}`);
        if (node.metadata?.locked) throw new Error(`节点已锁定：${id}`);
        return node;
    });
    return selected;
}

function changedIds(before: CanvasNodeData[], after: CanvasNodeData[]) {
    const oldById = new Map(before.map((node) => [node.id, node]));
    return after.filter((node) => JSON.stringify(oldById.get(node.id)) !== JSON.stringify(node)).map((node) => node.id);
}

export function createCanvasAgentFrameOperations(options: Options) {
    const { nodesRef } = options;

    function readback(before: CanvasNodeData[], createdFrame?: CanvasNodeData): CanvasAgentFrameMutation {
        const nodes = nodesRef.current;
        const beforeIds = new Set(before.map((node) => node.id));
        const freshFrame = createdFrame
            ? nodes.find((node) => node.id === createdFrame.id)
            : nodes.find((node) => !beforeIds.has(node.id) && isFrameNode(node));
        return { changedNodeIds: changedIds(before, nodes), nodes: nodes.map((node) => structuredClone(node)), createdFrame: freshFrame ? structuredClone(freshFrame) : undefined };
    }

    return {
        createLocalFolder(): CanvasAgentFrameMutation {
            const before = nodesRef.current;
            options.createFolder();
            const result = readback(before);
            if (!result.createdFrame) throw new Error("创建本机文件夹未产生 Frame");
            if (result.createdFrame.metadata?.folder?.assetFolderId) throw new Error("新建文件夹意外关联了远端素材目录");
            return result;
        },

        createStoryboardGroup(nodeIds: string[]): CanvasAgentFrameMutation {
            const before = nodesRef.current;
            const selected = requireExistingUnlocked(before, nodeIds);
            if (selected.some((node) => node.type !== CanvasNodeType.Image || !node.metadata?.content || node.parentId)) {
                throw new Error("分镜组仅接受未归组且已有内容的图片节点");
            }
            options.createStoryboardGroup(nodeIds);
            const result = readback(before);
            if (!result.createdFrame) throw new Error("创建分镜组未产生 Frame");
            return result;
        },

        createReferenceGroup(nodeIds: string[]): CanvasAgentFrameMutation {
            const before = nodesRef.current;
            const selected = requireExistingUnlocked(before, nodeIds);
            if (selected.some((node) => (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video) || !node.metadata?.content || node.parentId)) {
                throw new Error("引用组仅接受未归组且已有内容的图片或视频节点");
            }
            options.createReferenceGroup(nodeIds);
            const result = readback(before);
            if (!result.createdFrame) throw new Error("创建引用组未产生 Frame");
            return result;
        },

        async moveNodes(nodeIds: string[], targetFrameId: string | null): Promise<CanvasAgentFrameMutation> {
            const before = nodesRef.current;
            const moving = requireExistingUnlocked(before, nodeIds);
            if (moving.some((node) => isFrameNode(node))) throw new Error("不能移动 Frame 或文件夹节点");
            if (moving.some((node) => isHiddenBatchChild(node, before))) throw new Error("不能单独移动批量表子节点");
            if (targetFrameId !== null && (typeof targetFrameId !== "string" || !targetFrameId.trim())) throw new Error("targetFrameId 必须是明确的 Frame ID 或 null");

            const target = targetFrameId === null ? null : before.find((node) => node.id === targetFrameId);
            if (targetFrameId && (!target || !isFrameNode(target))) throw new Error(`目标不是有效 Frame：${targetFrameId}`);
            if (target?.metadata?.locked) throw new Error(`目标 Frame 已锁定：${target.id}`);
            if (target && moving.some((node) => node.id === target.id)) throw new Error("不能将 Frame 移入自身");

            if (target) {
                const accepts = target.metadata?.folder?.assetFolderId
                    ? canLinkedFolderArchive
                    : isCanvasFolderNode(target) ? canFolderContain : canFrameContain;
                if (moving.some((node) => !accepts(node))) throw new Error(`目标 Frame 不接受所选节点类型：${target.id}`);
            }

            const proposed = applyFrameDrop(before, new Set(nodeIds), targetFrameId);
            const proposedById = new Map(proposed.map((node) => [node.id, node]));
            if (moving.some((node) => (proposedById.get(node.id)?.parentId || undefined) !== (targetFrameId || undefined))) {
                throw new Error("Frame 拖放规则未能移动全部指定节点");
            }

            if (target?.metadata?.folder?.assetFolderId) {
                if (!options.archiveNodesToLinkedFolder) throw new Error("关联素材文件夹归档尚未接入 ensureCanvasNodeAsset，同步完成前拒绝移动");
                await options.archiveNodesToLinkedFolder(target.id, moving.map((node) => structuredClone(node)));
            }

            const latest = nodesRef.current;
            const latestTarget = targetFrameId === null ? null : latest.find((node) => node.id === targetFrameId);
            if (targetFrameId && (!latestTarget || !isFrameNode(latestTarget) || latestTarget.metadata?.folder?.assetFolderId !== target?.metadata?.folder?.assetFolderId)) {
                throw new Error("归档期间目标 Frame 已变化，未应用本地移动");
            }
            const latestMoving = nodeIds.map((id) => latest.find((node) => node.id === id));
            if (latestMoving.some((node, index) => !node || node.type !== moving[index].type || node.metadata?.locked)) {
                throw new Error("归档期间源节点已变化或锁定，未应用本地移动");
            }
            const rebased = applyFrameDrop(latest, new Set(nodeIds), targetFrameId);
            const rebasedById = new Map(rebased.map((node) => [node.id, node]));
            if (latestMoving.some((node) => (rebasedById.get(node!.id)?.parentId || undefined) !== (targetFrameId || undefined))) {
                throw new Error("同步后 Frame 拖放规则未能移动全部指定节点");
            }
            options.commitNodes(rebased);
            return readback(before);
        },
    };
}

export type CanvasAgentFrameOperations = ReturnType<typeof createCanvasAgentFrameOperations>;
