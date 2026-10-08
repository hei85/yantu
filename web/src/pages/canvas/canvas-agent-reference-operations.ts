import { applyCanvasConnectionPromptSync, buildCanvasNodeMentionReferenceMap, buildCanvasResourceReferences, canvasNodeMentionToken, replaceCanvasReferenceMentions, reorderCanvasResourceConnections } from "@/lib/canvas/canvas-resource-references";
import { getNodeAcceptedInputKinds } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export type CanvasAgentReferenceOperation =
    | { operation: "add"; targetNodeId: string; sourceNodeId: string; connectionId: string }
    | { operation: "remove"; targetNodeId: string; sourceNodeId: string }
    | { operation: "replace"; targetNodeId: string; sourceNodeId: string; oldSourceNodeId: string }
    | { operation: "reorder"; targetNodeId: string; sourceNodeIds: string[] };

export type CanvasAgentReferenceState = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    composerContent: string;
    references: Array<{ nodeId: string; label: string; kind: string }>;
};

type MutableRef<T> = { current: T };

/** Applies an explicit-ID reference edit to the live canvas refs and React state. */
export function applyCanvasAgentReferenceOperation(
    operation: CanvasAgentReferenceOperation,
    refs: { nodesRef: MutableRef<CanvasNodeData[]>; connectionsRef: MutableRef<CanvasConnection[]> },
    setters: { setNodes: (nodes: CanvasNodeData[]) => void; setConnections: (connections: CanvasConnection[]) => void },
): CanvasAgentReferenceState {
    const previousNodes = refs.nodesRef.current;
    const previousConnections = refs.connectionsRef.current;
    const nextNodesIndex = new Map(previousNodes.map((node) => [node.id, node]));
    const target = nextNodesIndex.get(operation.targetNodeId);
    if (!target) throw new Error(`目标节点不存在: ${operation.targetNodeId}`);
    let nextConnections = previousConnections;

    if (operation.operation === "add") {
        const source = requireSource(nextNodesIndex, operation.sourceNodeId);
        const receiverId = getReferenceReceiverId(target, previousNodes, previousConnections);
        assertCompatible(source, nextNodesIndex.get(receiverId)!);
        if (source.id === operation.targetNodeId) throw new Error("不能引用自身节点");
        const matches = previousConnections.filter((edge) => edge.fromNodeId === source.id && edge.toNodeId === receiverId);
        if (matches.length) throw new Error(matches.length > 1 ? "参考连线存在歧义" : "参考已存在");
        nextConnections = [...previousConnections, { id: operation.connectionId, fromNodeId: source.id, toNodeId: receiverId }];
    } else if (operation.operation === "remove") {
        requireSource(nextNodesIndex, operation.sourceNodeId);
        const receiverIds = getReferenceReceiverIds(target, previousNodes, previousConnections);
        const matches = previousConnections.filter((edge) => edge.fromNodeId === operation.sourceNodeId && receiverIds.includes(edge.toNodeId));
        if (matches.length !== 1) throw new Error(matches.length ? "参考连线存在歧义" : "参考连线不存在");
        nextConnections = previousConnections.filter((edge) => edge !== matches[0]);
    } else if (operation.operation === "replace") {
        const source = requireSource(nextNodesIndex, operation.sourceNodeId);
        requireSource(nextNodesIndex, operation.oldSourceNodeId);
        if (source.id === operation.oldSourceNodeId) throw new Error("新旧参考节点相同");
        const receiverIds = getReferenceReceiverIds(target, previousNodes, previousConnections);
        const oldEdges = previousConnections.filter((edge) => edge.fromNodeId === operation.oldSourceNodeId && receiverIds.includes(edge.toNodeId));
        if (oldEdges.length !== 1) throw new Error(oldEdges.length ? "旧参考连线存在歧义" : "旧参考连线不存在");
        const receiver = nextNodesIndex.get(oldEdges[0].toNodeId)!;
        assertCompatible(source, receiver);
        const duplicate = previousConnections.filter((edge) => edge.fromNodeId === source.id && edge.toNodeId === receiver.id);
        if (duplicate.length) throw new Error(duplicate.length > 1 ? "新参考连线存在歧义" : "新参考已存在");
        nextConnections = previousConnections.map((edge) => edge === oldEdges[0] ? { ...edge, fromNodeId: source.id } : edge);
    } else {
        const ids = operation.sourceNodeIds;
        if (new Set(ids).size !== ids.length) throw new Error("重排列表包含重复节点");
        for (const id of ids) requireSource(nextNodesIndex, id);
        const revised = reorderCanvasResourceConnections(operation.targetNodeId, ids, previousNodes, previousConnections);
        if (revised === previousConnections) throw new Error("参考顺序不完整或无法重排");
        nextConnections = revised;
    }

    let nextNodes = applyCanvasConnectionPromptSync(previousNodes, previousConnections, previousNodes, nextConnections);
    if (operation.operation === "add") {
        const ref = buildCanvasNodeMentionReferenceMap(nextNodes, nextConnections).get(operation.targetNodeId)?.find((item) => item.nodeId === operation.sourceNodeId);
        if (!ref) throw new Error("参考连线未建立");
        const content = nextNodes.find((node) => node.id === operation.targetNodeId)?.metadata?.composerContent ?? "";
        const token = canvasNodeMentionToken(operation.sourceNodeId);
        if (!content.includes(token) && !content.includes(`@${ref.label}`)) {
            nextNodes = nextNodes.map((node) => node.id === operation.targetNodeId ? { ...node, metadata: { ...node.metadata, composerContent: [content.trim(), token].filter(Boolean).join(" ") } } : node);
            nextNodes = applyCanvasConnectionPromptSync(nextNodes, nextConnections, nextNodes, nextConnections);
        }
    }
    if (operation.operation === "replace") {
        const refsMap = buildCanvasNodeMentionReferenceMap(nextNodes, nextConnections);
        const newRef = refsMap.get(operation.targetNodeId)?.find((item) => item.nodeId === operation.sourceNodeId);
        const oldRef = buildCanvasNodeMentionReferenceMap(previousNodes, previousConnections).get(operation.targetNodeId)?.find((item) => item.nodeId === operation.oldSourceNodeId);
        if (newRef && oldRef) {
            const previousPrompt = target.metadata?.composerContent ?? target.metadata?.prompt ?? "";
            nextNodes = nextNodes.map((node) => node.id === operation.targetNodeId ? {
                ...node,
                metadata: { ...node.metadata, composerContent: replaceCanvasReferenceMentions(previousPrompt, oldRef, canvasNodeMentionToken(operation.sourceNodeId), newRef.title) },
            } : node);
            nextNodes = applyCanvasConnectionPromptSync(nextNodes, nextConnections, nextNodes, nextConnections);
        }
    }

    refs.nodesRef.current = nextNodes;
    refs.connectionsRef.current = nextConnections;
    setters.setNodes(nextNodes);
    setters.setConnections(nextConnections);
    const updatedTarget = nextNodes.find((node) => node.id === operation.targetNodeId)!;
    const prompt = updatedTarget.metadata?.composerContent ?? updatedTarget.metadata?.prompt ?? "";
    return {
        nodes: nextNodes,
        connections: nextConnections,
        composerContent: prompt,
        references: (buildCanvasNodeMentionReferenceMap(nextNodes, nextConnections).get(operation.targetNodeId) || []).map(({ nodeId, label, kind }) => ({ nodeId, label, kind })),
    };
}

function requireSource(nodes: Map<string, CanvasNodeData>, id: string) {
    const node = nodes.get(id);
    if (!node) throw new Error(`来源节点不存在: ${id}`);
    if (!buildCanvasResourceReferences([node], []).length) throw new Error(`来源节点类型不适合作为参考: ${id}`);
    return node;
}

function assertCompatible(source: CanvasNodeData, receiver: CanvasNodeData) {
    const accepted = getNodeAcceptedInputKinds(receiver.type);
    const reference = buildCanvasResourceReferences([source], [])[0];
    if (accepted.length && (!reference || !accepted.includes(reference.kind as never))) throw new Error("目标节点不接受该类型的参考");
}

function getReferenceReceiverIds(target: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configEdges = connections.filter((edge) => edge.fromNodeId === target.id && nodes.find((node) => node.id === edge.toNodeId)?.type === CanvasNodeType.Config);
    if (configEdges.length > 1) throw new Error("目标节点连接了多个配置节点");
    const configId = configEdges[0]?.toNodeId;
    if (!configId) return [target.id];
    const configReferences = buildCanvasNodeMentionReferenceMap(nodes, connections).get(configId) || [];
    return configReferences.some((reference) => reference.nodeId !== target.id) ? [configId] : [target.id];
}

function getReferenceReceiverId(target: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return getReferenceReceiverIds(target, nodes, connections)[0];
}
