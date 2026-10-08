import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

/** Collapse only derived shortcuts that already have a complete, row-specific visible path.
 * This is a display filter: generation, smart mentions and persistence keep the original graph.
 */
export function collapsedStoryboardReferenceConnectionIds(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const rows = new Map<string, { assets: Set<string>; targets: Set<string> }>();
    const key = (...parts: string[]) => parts.join("\0");
    for (const node of nodes) {
        if (node.type !== CanvasNodeType.Script) continue;
        for (const row of node.metadata?.storyboard?.rows || []) {
            rows.set(key(node.id, row.id), {
                assets: new Set([
                    ...(row.assetBindings || []).map((binding) => binding.nodeId),
                    ...(row.characters || []).map((character) => character.characterImageNodeId || ""),
                ].filter(Boolean)),
                targets: new Set([
                    row.imageNodeId, row.videoNodeId,
                    ...(row.segmentBindings || []).map((segment) => segment.videoNodeId),
                ].filter((id): id is string => Boolean(id))),
            });
        }
    }
    const rowInputs = new Set<string>();
    const owners = new Map<string, Set<string>>();
    for (const edge of connections) {
        if (edge.toHandleId?.startsWith("row:")) {
            rowInputs.add(key(edge.fromNodeId, edge.toNodeId, edge.toHandleId.slice(4)));
        }
        const rowId = edge.storyboardRowId;
        if (edge.relation !== "storyboard-output" || !rowId || edge.fromHandleId !== `row:${rowId}`) continue;
        if (!rows.get(key(edge.fromNodeId, rowId))?.targets.has(edge.toNodeId)) continue;
        const outputKey = key(edge.toNodeId, rowId);
        const scripts = owners.get(outputKey) || new Set<string>();
        scripts.add(edge.fromNodeId);
        owners.set(outputKey, scripts);
    }
    const collapsed = new Set<string>();
    for (const edge of connections) {
        const rowId = edge.storyboardRowId;
        if (edge.relation !== "storyboard-asset-reference" || !rowId || !nodeById.has(edge.fromNodeId)) continue;
        const target = nodeById.get(edge.toNodeId);
        if (!target || target.type !== CanvasNodeType.Video) continue;
        const scripts = owners.get(key(edge.toNodeId, rowId));
        if (scripts?.size !== 1) continue;
        const scriptId = scripts.values().next().value!;
        if (!rows.get(key(scriptId, rowId))?.assets.has(edge.fromNodeId)) continue;
        if (!rowInputs.has(key(edge.fromNodeId, scriptId, rowId))) continue;
        collapsed.add(edge.id);
    }
    return collapsed;
}
