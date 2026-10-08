import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "@/types/canvas";

const NODE_GAP_X = 72;
const NODE_GAP_Y = 72;
const SECTION_GAP = 96;
const SECTION_TITLE_HEIGHT = 32;
const FRAME_HEADER_HEIGHT = 36;
const FRAME_PADDING = 24;

export type CanvasOrganizeSection = {
    key: string;
    nodeIds: string[];
    columns: number;
    rows: number;
    bounds: { x: number; y: number; width: number; height: number };
};

export type OrganizeCanvasResult = {
    patches: Map<string, Partial<CanvasNodeData>>;
    sections: CanvasOrganizeSection[];
    preservedNodeIds: string[];
};

type Group = { key: string; nodes: CanvasNodeData[] };

/**
 * Pure, deterministic canvas organization. Positions are world coordinates, including frame children.
 * The function deliberately does not alter IDs, edges, node sizes, or generation settings.
 */
export function organizeCanvasNodes(
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
    options?: { nodeIds?: string[]; groupByMedia?: boolean },
): OrganizeCanvasResult {
    const patches = new Map<string, Partial<CanvasNodeData>>();
    const sections: CanvasOrganizeSection[] = [];
    const preserved = new Set<string>();
    if (!nodes.length) return { patches, sections, preservedNodeIds: [] };

    const byId = new Map(nodes.map((node) => [node.id, node]));
    const originalIndex = new Map(nodes.map((node, index) => [node.id, index]));
    const selected = options?.nodeIds ? new Set(options.nodeIds) : null;
    const children = new Map<string, CanvasNodeData[]>();
    for (const node of nodes) {
        if (!node.parentId || !byId.has(node.parentId) || node.parentId === node.id) continue;
        const list = children.get(node.parentId) || [];
        list.push(node);
        children.set(node.parentId, list);
    }

    // Match the canvas' hidden batch child rule without importing its store/domain module.
    const hiddenBatchChild = (node: CanvasNodeData) => {
        const rootId = node.metadata?.batchRootId;
        const root = rootId ? byId.get(rootId) : undefined;
        return Boolean(root && !root.metadata?.imageBatchExpanded);
    };
    const isFrame = (node?: CanvasNodeData) => node?.type === CanvasNodeType.Frame;
    const isLocked = (node: CanvasNodeData) => Boolean(node.metadata?.locked);
    const dimensions = (node: CanvasNodeData) => ({
        width: safeSize(patches.get(node.id)?.width ?? node.width),
        height: safeSize(patches.get(node.id)?.height ?? node.height),
    });
    const descendantIds = (id: string, result = new Set<string>()): Set<string> => {
        for (const child of children.get(id) || []) {
            if (result.has(child.id)) continue;
            result.add(child.id);
            descendantIds(child.id, result);
        }
        return result;
    };
    const placeNode = (node: CanvasNodeData, position: Position) => {
        const previous = patches.get(node.id)?.position || node.position;
        patches.set(node.id, { ...patches.get(node.id), position });
        if (!isFrame(node)) return;
        const dx = position.x - previous.x;
        const dy = position.y - previous.y;
        const descendants = descendantIds(node.id);
        for (const id of descendants) {
            const child = byId.get(id)!;
            const current = patches.get(id)?.position || child.position;
            patches.set(id, { ...patches.get(id), position: { x: current.x + dx, y: current.y + dy } });
        }
        for (const section of sections) {
            if (section.nodeIds.every((id) => descendants.has(id))) {
                section.bounds.x += dx;
                section.bounds.y += dy;
            }
        }
    };
    const categoryOf = (node: CanvasNodeData): string => {
        if (node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Script || node.type === CanvasNodeType.Markdown || node.type === CanvasNodeType.Skill || node.type === CanvasNodeType.Config || node.type === CanvasNodeType.Chart) return "文字与规划";
        if (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Drawing || node.type === CanvasNodeType.Panorama || node.type === CanvasNodeType.Compare || node.type === CanvasNodeType.ColorGrade) return "图片与参考";
        if (node.type === CanvasNodeType.Video) return "视频";
        if (node.type === CanvasNodeType.Audio) return "音频";
        if (isFrame(node) || node.type === CanvasNodeType.BatchTable) return "容器与批量";
        return "其它";
    };

    // A malformed parent cycle or any locked descendant freezes that entire containing frame tree.
    const subtreeHasLock = (id: string, visiting = new Set<string>()): boolean => {
        if (visiting.has(id)) return true;
        const node = byId.get(id);
        if (!node) return false;
        if (isLocked(node)) return true;
        if (!isFrame(node)) return false;
        const next = new Set(visiting);
        next.add(id);
        return (children.get(id) || []).some((child) => subtreeHasLock(child.id, next));
    };

    const isDescendantOfSelectedFrame = (node: CanvasNodeData) => {
        if (!selected) return true;
        let parentId = node.parentId;
        const seen = new Set<string>([node.id]);
        while (parentId && !seen.has(parentId)) {
            if (selected.has(parentId) && isFrame(byId.get(parentId)!)) return true;
            seen.add(parentId);
            parentId = byId.get(parentId)?.parentId;
        }
        return false;
    };
    const requested = (node: CanvasNodeData) => !selected || selected.has(node.id) || isDescendantOfSelectedFrame(node);
    const requestedFrameChild = (node: CanvasNodeData) => {
        if (!selected) return true;
        let parentId = node.parentId;
        const seen = new Set<string>([node.id]);
        while (parentId && !seen.has(parentId)) {
            const parent = byId.get(parentId);
            if (!parent) return false;
            if (selected.has(parent.id) && isFrame(parent)) return true;
            seen.add(parentId);
            parentId = parent.parentId;
        }
        return false;
    };

    const sortForSection = (items: CanvasNodeData[]) => {
        // Stable Kahn ordering keeps connected production steps intuitive while all nodes remain in a grid.
        const ids = new Set(items.map((node) => node.id));
        const indegree = new Map(items.map((node) => [node.id, 0]));
        const outgoing = new Map(items.map((node) => [node.id, [] as string[]]));
        for (const edge of connections) {
            if (!ids.has(edge.fromNodeId) || !ids.has(edge.toNodeId) || edge.fromNodeId === edge.toNodeId) continue;
            outgoing.get(edge.fromNodeId)!.push(edge.toNodeId);
            indegree.set(edge.toNodeId, (indegree.get(edge.toNodeId) || 0) + 1);
        }
        const orderIndex = (id: string) => originalIndex.get(id) ?? Number.MAX_SAFE_INTEGER;
        const ready = items.filter((node) => indegree.get(node.id) === 0).sort((a, b) => orderIndex(a.id) - orderIndex(b.id));
        const result: CanvasNodeData[] = [];
        while (ready.length) {
            const node = ready.shift()!;
            result.push(node);
            for (const target of outgoing.get(node.id) || []) {
                const next = (indegree.get(target) || 0) - 1;
                indegree.set(target, next);
                if (next === 0) {
                    ready.push(byId.get(target)!);
                    ready.sort((a, b) => orderIndex(a.id) - orderIndex(b.id));
                }
            }
        }
        for (const node of items) if (!result.some((entry) => entry.id === node.id)) result.push(node); // cycles stay in input order
        return result;
    };

    const getGroups = (items: CanvasNodeData[]): Group[] => {
        const sorted = sortForSection(items);
        if (options?.groupByMedia === false) return sorted.length ? [{ key: "全部节点", nodes: sorted }] : [];
        const keys = ["文字与规划", "图片与参考", "视频", "音频", "容器与批量", "其它"];
        return keys.map((key) => ({ key, nodes: sorted.filter((node) => categoryOf(node) === key) })).filter((group) => group.nodes.length > 0);
    };

    const gridMetrics = (items: CanvasNodeData[]) => {
        const columns = Math.max(1, Math.ceil(Math.sqrt(items.length)));
        const rows = Math.ceil(items.length / columns);
        const colWidths = Array.from({ length: columns }, (_, col) => Math.max(...items.filter((_, index) => index % columns === col).map((node) => dimensions(node).width)));
        const rowHeights = Array.from({ length: rows }, (_, row) => Math.max(...items.slice(row * columns, (row + 1) * columns).map((node) => dimensions(node).height)));
        const xOffsets: number[] = [];
        const yOffsets: number[] = [];
        let x = 0;
        let y = 0;
        for (const width of colWidths) { xOffsets.push(x); x += width + NODE_GAP_X; }
        for (const height of rowHeights) { yOffsets.push(y); y += height + NODE_GAP_Y; }
        return { columns, rows, colWidths, rowHeights, xOffsets, yOffsets, width: x - NODE_GAP_X, height: y - NODE_GAP_Y };
    };

    const layoutGroups = (groups: Group[], origin: Position, keyPrefix: string, movableIds: Set<string>) => {
        if (!groups.length) return { width: 0, height: 0 };
        const blocks = groups.map((group) => {
            const grid = gridMetrics(group.nodes);
            return { group, grid, width: grid.width, height: grid.height + SECTION_TITLE_HEIGHT };
        });
        const blockColumns = Math.max(1, Math.ceil(Math.sqrt(blocks.length)));
        const blockRows = Math.ceil(blocks.length / blockColumns);
        const colWidths = Array.from({ length: blockColumns }, (_, col) => Math.max(...blocks.filter((_, index) => index % blockColumns === col).map((block) => block.width)));
        const rowHeights = Array.from({ length: blockRows }, (_, row) => Math.max(...blocks.slice(row * blockColumns, (row + 1) * blockColumns).map((block) => block.height)));
        const bx: number[] = [];
        const by: number[] = [];
        let cursorX = 0;
        let cursorY = 0;
        for (const width of colWidths) { bx.push(cursorX); cursorX += width + SECTION_GAP; }
        for (const height of rowHeights) { by.push(cursorY); cursorY += height + SECTION_GAP; }

        blocks.forEach(({ group, grid }, blockIndex) => {
            const blockX = origin.x + bx[blockIndex % blockColumns];
            const blockY = origin.y + by[Math.floor(blockIndex / blockColumns)];
            const nodeIds: string[] = [];
            group.nodes.forEach((node, index) => {
                nodeIds.push(node.id);
                if (!movableIds.has(node.id)) return;
                // Align card tops and column left edges even when cards have different sizes.
                placeNode(node, { x: blockX + grid.xOffsets[index % grid.columns], y: blockY + SECTION_TITLE_HEIGHT + grid.yOffsets[Math.floor(index / grid.columns)] });
            });
            sections.push({ key: `${keyPrefix}${group.key}`, nodeIds, columns: grid.columns, rows: grid.rows, bounds: { x: blockX, y: blockY, width: grid.width, height: grid.height + SECTION_TITLE_HEIGHT } });
        });
        return { width: cursorX - SECTION_GAP, height: cursorY - SECTION_GAP };
    };

    const markSubtreePreserved = (id: string, seen = new Set<string>()) => {
        if (seen.has(id)) return;
        seen.add(id);
        preserved.add(id);
        for (const child of children.get(id) || []) markSubtreePreserved(child.id, seen);
    };

    const preserveBranchButVisitSelectedFrames = (node: CanvasNodeData, seen = new Set<string>()) => {
        if (seen.has(node.id)) return;
        seen.add(node.id);
        if (isFrame(node) && selected?.has(node.id) && !subtreeHasLock(node.id)) {
            processFrame(node);
            return;
        }
        preserved.add(node.id);
        for (const child of children.get(node.id) || []) preserveBranchButVisitSelectedFrames(child, seen);
    };

    // First identify locked frames/cycles; recursively process frame contents before positioning their parent.
    const processedFrames = new Set<string>();
    const processFrame = (frame: CanvasNodeData) => {
        if (processedFrames.has(frame.id)) return;
        processedFrames.add(frame.id);
        const direct = children.get(frame.id) || [];
        if (subtreeHasLock(frame.id)) {
            markSubtreePreserved(frame.id);
            return;
        }
        const movable: CanvasNodeData[] = [];
        const fixed: CanvasNodeData[] = [];
        for (const child of direct) {
            if (hiddenBatchChild(child) || isLocked(child)) { markSubtreePreserved(child.id); fixed.push(child); continue; }
            if (!requestedFrameChild(child)) { markSubtreePreserved(child.id); fixed.push(child); continue; }
            if (isFrame(child)) processFrame(child);
            movable.push(child);
        }
        if (!movable.length) return;
        const movedIds = new Set(movable.map((node) => node.id));
        const localOrigin = fixed.length
            ? { x: Math.max(...fixed.map((node) => node.position.x + safeSize(node.width))) + NODE_GAP_X, y: frame.position.y + FRAME_HEADER_HEIGHT + FRAME_PADDING }
            : { x: frame.position.x + FRAME_PADDING, y: frame.position.y + FRAME_HEADER_HEIGHT + FRAME_PADDING };
        const layout = layoutGroups(getGroups(movable), localOrigin, `${frame.title || "Frame"} / `, movedIds);
        const movedBoxes = movable.map((node) => {
            const pos = patches.get(node.id)?.position || node.position;
            return { right: pos.x + dimensions(node).width, bottom: pos.y + dimensions(node).height };
        });
        const childRight = Math.max(...movedBoxes.map((box) => box.right), ...fixed.map((node) => node.position.x + dimensions(node).width));
        const childBottom = Math.max(...movedBoxes.map((box) => box.bottom), ...fixed.map((node) => node.position.y + dimensions(node).height));
        const previousWidth = Math.max(frame.width, frame.metadata?.frame?.expandedWidth || 0);
        const previousHeight = Math.max(frame.height, frame.metadata?.frame?.expandedHeight || 0);
        const requiredWidth = Math.max(previousWidth, childRight - frame.position.x + FRAME_PADDING);
        const requiredHeight = Math.max(previousHeight, layout.height + FRAME_HEADER_HEIGHT + FRAME_PADDING * 2, childBottom - frame.position.y + FRAME_PADDING);
        const width = near(requiredWidth, previousWidth) ? previousWidth : requiredWidth;
        const height = near(requiredHeight, previousHeight) ? previousHeight : requiredHeight;
        const frameMetadata = { ...frame.metadata, frame: { ...frame.metadata?.frame, collapsed: Boolean(frame.metadata?.frame?.collapsed), expandedWidth: width, expandedHeight: height } };
        if (frame.metadata?.frame?.collapsed) {
            if (width !== frame.metadata.frame.expandedWidth || height !== frame.metadata.frame.expandedHeight) patches.set(frame.id, { ...patches.get(frame.id), metadata: frameMetadata });
        } else {
            const old = patches.get(frame.id) || {};
            patches.set(frame.id, { ...old, width: Math.max(frame.width, width), height: Math.max(frame.height, height), metadata: frameMetadata });
        }
        // A later parent move shifts this frame's descendants as one world-space subtree.
    };

    // Determine selectable/movable top-level nodes. An individually selected child inside an unselected frame is preserved.
    const roots = nodes.filter((node) => !node.parentId || !byId.has(node.parentId));
    const movableRoots: CanvasNodeData[] = [];
    const fixedRoots: CanvasNodeData[] = [];
    for (const root of roots) {
        if (hiddenBatchChild(root) || isLocked(root) || subtreeHasLock(root.id) && isFrame(root)) {
            markSubtreePreserved(root.id);
            fixedRoots.push(root);
        } else if (requested(root)) {
            movableRoots.push(root);
            if (isFrame(root)) processFrame(root);
        } else {
            preserveBranchButVisitSelectedFrames(root);
            fixedRoots.push(root);
        }
    }

    // Orphan descendants of malformed cycles cannot be safely attached; leave them untouched.
    const rootReachable = new Set<string>();
    const visit = (id: string, seen = new Set<string>()) => {
        if (seen.has(id)) return;
        seen.add(id);
        rootReachable.add(id);
        for (const child of children.get(id) || []) visit(child.id, seen);
    };
    roots.forEach((root) => visit(root.id));
    for (const node of nodes) if (!rootReachable.has(node.id)) markSubtreePreserved(node.id);

    const movableIds = new Set<string>();
    for (const root of movableRoots) {
        if (hiddenBatchChild(root) || isLocked(root)) continue;
        movableIds.add(root.id);
    }
    if (movableRoots.length) {
        const obstacles = [...fixedRoots, ...nodes.filter((node) => !rootReachable.has(node.id))];
        const fixedBounds = obstacles.map((node) => ({ x: node.position.x, y: node.position.y, ...dimensions(node) }));
        const origin = fixedBounds.length
            ? { x: Math.max(...fixedBounds.map((box) => box.x + box.width)) + NODE_GAP_X, y: Math.min(...fixedBounds.map((box) => box.y)) }
            : { x: Math.min(...movableRoots.map((node) => node.position.x)), y: Math.min(...movableRoots.map((node) => node.position.y)) - SECTION_TITLE_HEIGHT };
        layoutGroups(getGroups(movableRoots), origin, "", movableIds);
    }

    for (const node of nodes) {
        if (hiddenBatchChild(node)) preserved.add(node.id);
        if (isLocked(node)) preserved.add(node.id);
    }
    // Apply parent frame changes before descendant world-coordinate patches.
    const depthOf = (node: CanvasNodeData) => {
        let depth = 0;
        let parentId = node.parentId;
        const seen = new Set<string>([node.id]);
        while (parentId && !seen.has(parentId)) {
            seen.add(parentId);
            depth++;
            parentId = byId.get(parentId)?.parentId;
        }
        return depth;
    };
    const changedAncestor = (node: CanvasNodeData) => {
        let parentId = node.parentId;
        const seen = new Set<string>();
        while (parentId && !seen.has(parentId)) {
            seen.add(parentId);
            const parent = byId.get(parentId);
            const position = patches.get(parentId)?.position;
            if (parent && position && (!near(position.x, parent.position.x) || !near(position.y, parent.position.y))) return true;
            parentId = parent?.parentId;
        }
        return false;
    };
    const changes = [...patches.entries()].flatMap(([id, patch]) => {
        const node = byId.get(id)!;
        const next = { ...patch };
        if (next.position && near(next.position.x, node.position.x) && near(next.position.y, node.position.y) && !changedAncestor(node)) delete next.position;
        if (next.width !== undefined && near(next.width, node.width)) delete next.width;
        if (next.height !== undefined && near(next.height, node.height)) delete next.height;
        if (next.metadata && JSON.stringify(next.metadata) === JSON.stringify(node.metadata)) delete next.metadata;
        return Object.keys(next).length ? [[id, next] as const] : [];
    });
    const orderedPatches = new Map(changes.sort((a, b) => depthOf(byId.get(a[0])!) - depthOf(byId.get(b[0])!)));
    return { patches: orderedPatches, sections, preservedNodeIds: nodes.filter((node) => preserved.has(node.id)).map((node) => node.id) };
}

function safeSize(value: number) {
    return Number.isFinite(value) && value > 0 ? value : 1;
}

function near(a: number, b: number) { return Math.abs(a - b) < 0.000001; }
