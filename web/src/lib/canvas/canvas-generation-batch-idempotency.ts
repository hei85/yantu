import type { CanvasNodeData } from "@/types/canvas";

export function batchRowClientOperationId(batchOperationId: string, rowId: string) {
    return `canvas-batch:${stableDigest(stableSerialize({ batchOperationId, rowId }))}`;
}

export function batchRowRequestFingerprint(projectId: string, rowId: string, node: CanvasNodeData, mode: string, model: string, options: Record<string, unknown>, sourceNode?: CanvasNodeData, allNodes: CanvasNodeData[] = [node]) {
    const row = sourceNode?.metadata?.storyboard?.rows?.find((candidate) => candidate.id === rowId);
    const batchRow = sourceNode?.metadata?.batchTable?.rows?.find((candidate) => candidate.id === rowId);
    const referenceNodeIds = new Set([
        ...(sourceNode?.metadata?.storyboard?.referenceNodeIds || []),
        ...(row?.assetBindings || []).map((binding) => binding.nodeId),
        ...(row?.characters || []).map((character) => character.characterImageNodeId).filter((id): id is string => Boolean(id)),
        ...(mode === "video" && typeof node.metadata?.videoStartFrameNodeId === "string" ? [node.metadata.videoStartFrameNodeId] : []),
        ...(mode === "batch_image" ? (batchRow?.inputNodeIds || []) : []),
        ...(mode === "batch_image" ? (batchRow?.textNodeIds || []) : []),
    ]);
    const references = [...referenceNodeIds].sort().map((id) => {
        const reference = allNodes.find((candidate) => candidate.id === id);
        if (!reference) return { id, missing: true };
        const storageKey = reference.metadata?.storageKey;
        // Canvas media hydration can replace a temporary preview/data URL with
        // a resolved URL after a batch is queued. When a stable backing key is
        // available, it identifies the submitted media; hashing `content`
        // here would mistake that representation change for a new input.
        const contentFingerprint = !storageKey && typeof reference.metadata?.content === "string"
            ? stableDigest(reference.metadata.content)
            : undefined;
        return {
            id,
            type: reference.type,
            title: reference.title,
            updatedAt: reference.updatedAt,
            assetId: reference.metadata?.assetId,
            storageKey,
            characterAssetId: reference.metadata?.characterAssetId,
            contentFingerprint,
            promptFingerprint: typeof reference.metadata?.prompt === "string" ? stableDigest(reference.metadata.prompt) : undefined,
        };
    });
    const stableRow = row ? { ...row, status: undefined, errorDetails: undefined, segmentBindings: undefined } : undefined;
    return stableDigest(stableSerialize({
        projectId,
        rowId,
        nodeId: node.id,
        mode,
        prompt: (node.metadata?.composerContent || node.metadata?.prompt || "").trim(),
        model,
        storyboardRow: stableRow,
        batchTableRow: mode === "batch_image" && batchRow ? { ...batchRow, outputNodeId: undefined } : undefined,
        batchTableGlobalPrompt: mode === "batch_image" ? sourceNode?.metadata?.batchTable?.globalPrompt : undefined,
        // The video start frame is an effective generation input even when it is
        // absent from the storyboard's general reference bindings.
        videoStartFrameNodeId: mode === "video" ? node.metadata?.videoStartFrameNodeId : undefined,
        storyboardReferenceNodeIds: [...referenceNodeIds].sort(),
        references,
        options,
    }));
}

function stableDigest(value: string) {
    let left = 2166136261;
    let right = 0x9e3779b9;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        left = Math.imul(left ^ code, 16777619);
        right = Math.imul(right ^ code, 2246822519);
    }
    return `${value.length.toString(36)}-${(left >>> 0).toString(36)}${(right >>> 0).toString(36)}`;
}

function stableSerialize(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
    if (value && typeof value === "object") {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(object[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "undefined";
}
