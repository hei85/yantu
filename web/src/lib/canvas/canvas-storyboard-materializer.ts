import { nanoid } from "nanoid";

import { storyboardAssetRoleForNode } from "@/lib/canvas/canvas-storyboard-assets";
import { buildOrderedCanvasResourceReferences, canvasResourceMentionToken, normalizeCanvasNodeMentionTokens } from "@/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type StoryboardAssetBinding, type StoryboardRow } from "@/types/canvas";

export function storyboardRowReferenceNodeIds(
    scriptNode: CanvasNodeData,
    row: StoryboardRow,
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
    includeFirstFrame: boolean,
    targetNodeId?: string,
) {
    const characterAssetIds = new Set((row.characters || []).map((character) => character.characterAssetId).filter((assetId): assetId is string => Boolean(assetId)));
    const characterNodeIds = nodes
        .filter((node) => node.metadata?.workflowKind === "character" && Boolean(node.metadata.characterAssetId) && characterAssetIds.has(node.metadata.characterAssetId!))
        .map((node) => node.id);
    const referenceIds = new Set([
        ...(scriptNode.metadata?.storyboard?.referenceNodeIds || []),
        ...(row.assetBindings || []).map((binding) => binding.nodeId),
        ...characterNodeIds,
        ...connections.filter((connection) => connection.toNodeId === scriptNode.id && connection.toHandleId === `row:${row.id}`).map((connection) => connection.fromNodeId),
        ...(targetNodeId ? connections.filter((connection) => !connection.relation && connection.toNodeId === targetNodeId).map((connection) => connection.fromNodeId) : []),
        ...(includeFirstFrame && row.imageNodeId ? [row.imageNodeId] : []),
    ]);
    if (!includeFirstFrame && row.imageNodeId) referenceIds.delete(row.imageNodeId);
    referenceIds.delete(scriptNode.id);
    return Array.from(referenceIds).filter((nodeId) => nodes.some((node) => node.id === nodeId));
}

export function storyboardComposerContent(prompt: string, referenceNodeIds: string[], nodes: CanvasNodeData[]) {
    const referenceIds = Array.from(new Set(referenceNodeIds));
    const referenceNodes = referenceIds.flatMap((nodeId) => {
        const node = nodes.find((candidate) => candidate.id === nodeId);
        return node ? [node] : [];
    });
    const references = buildOrderedCanvasResourceReferences(referenceNodes);
    const mentions = references.map(canvasResourceMentionToken);
    // Canonicalize explicit @[node:id] references before this content is
    // fingerprinted. The canvas mention-sync effect applies this same rewrite
    // after React commits the new reference connections; doing it here keeps
    // enqueue-time and scheduler-time prompts identical.
    const normalizedPrompt = normalizeCanvasNodeMentionTokens(prompt.trim(), references);
    // Preserve references placed beside the action they describe; only add
    // connected references that the prompt has not already cited inline.
    const missingMentions = mentions.filter((mention) => !normalizedPrompt.includes(mention));
    return missingMentions.length ? [`参考资产：${missingMentions.join(" ")}`, normalizedPrompt].filter(Boolean).join("\n") : normalizedPrompt;
}

export function storyboardVideoPrompt(row: StoryboardRow) {
    return row.videoMotionPrompt.trim() || row.plotDescription.trim();
}

export function storyboardVideoOperation(row: StoryboardRow, existing?: CanvasNodeData) {
    if (row.videoOperation) return row.videoOperation;
    const existingOperation = existing?.metadata?.videoEditOperation;
    if (existingOperation && existingOperation !== "text_to_video") return existingOperation;
    if (row.imageNodeId || existing?.metadata?.videoStartFrameNodeId || existing?.metadata?.videoEndFrameNodeId) return "image_to_video";
    return existingOperation || "text_to_video";
}

export function storyboardVideoFrameNodeIds(row: StoryboardRow, existing?: CanvasNodeData) {
    return [...new Set([
        existing?.metadata?.videoStartFrameNodeId,
        existing?.metadata?.videoEndFrameNodeId,
        ...(storyboardVideoOperation(row, existing) === "image_to_video" ? [row.imageNodeId] : []),
    ].filter((nodeId): nodeId is string => typeof nodeId === "string" && Boolean(nodeId.trim())))];
}

export function reconcileStoryboardTargetConnections(
    connections: CanvasConnection[],
    scriptNode: CanvasNodeData,
    row: StoryboardRow,
    targetNodeId: string,
    referenceNodeIds: string[],
    targetKind: "image" | "video" = "video",
) {
    const desired = new Set(referenceNodeIds.filter((nodeId) => nodeId !== targetNodeId && nodeId !== scriptNode.id));
    const next = connections.filter((connection) => {
        if (connection.storyboardRowId !== row.id || connection.toNodeId !== targetNodeId) return true;
        if (connection.relation === "storyboard-output") return targetKind === "video" && connection.fromNodeId === scriptNode.id;
        if (connection.relation === "storyboard-asset-reference") return targetKind === "image" && desired.has(connection.fromNodeId);
        return true;
    });
    if (targetKind === "video" && !next.some((connection) => connection.fromNodeId === scriptNode.id && connection.toNodeId === targetNodeId && connection.fromHandleId === `row:${row.id}`)) {
        next.push({ id: nanoid(), fromNodeId: scriptNode.id, toNodeId: targetNodeId, fromHandleId: `row:${row.id}`, relation: "storyboard-output", storyboardRowId: row.id });
    }
    if (targetKind === "image") desired.forEach((fromNodeId) => {
        if (!next.some((connection) => connection.fromNodeId === fromNodeId && connection.toNodeId === targetNodeId)) {
            next.push({ id: nanoid(), fromNodeId, toNodeId: targetNodeId, relation: "storyboard-asset-reference", storyboardRowId: row.id });
        }
    });
    return next;
}

export function bindingForConnectedNode(node: CanvasNodeData): StoryboardAssetBinding | null {
    const role = storyboardAssetRoleForNode(node);
    return role ? { nodeId: node.id, role, priority: defaultRolePriority(role) } : null;
}

export function isStoryboardPreviewAsset(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Drawing || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio || node.metadata?.workflowKind === "character";
}

function defaultRolePriority(role: StoryboardAssetBinding["role"]) {
    if (role === "character") return 100;
    if (role === "environment") return 90;
    if (role === "prop" || role === "weapon" || role === "wardrobe") return 80;
    if (role === "motion" || role === "audio") return 70;
    return 60;
}
