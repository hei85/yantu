export type CanvasMediaNodeState = {
    id: string;
    type: string;
    metadata?: { assetId?: unknown };
};

export type CanvasMediaNodePersistenceExpectation = {
    nodeId: string;
    nodeType: string;
    assetId: string;
};

/** Wait for the page's persisted canvas store to catch up with a native media-node replacement. */
export async function waitForCanvasMediaNodeState(
    readNodes: () => readonly CanvasMediaNodeState[] | undefined,
    expected: CanvasMediaNodePersistenceExpectation,
    options: { attempts?: number; intervalMs?: number } = {},
) {
    const attempts = Math.max(1, Math.floor(options.attempts ?? 100));
    const intervalMs = Math.max(0, options.intervalMs ?? 20);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const node = readNodes()?.find((candidate) => candidate.id === expected.nodeId);
        if (node?.type === expected.nodeType && node.metadata?.assetId === expected.assetId) return true;
        if (attempt + 1 < attempts && intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
}
