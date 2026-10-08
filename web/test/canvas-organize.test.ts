import { describe, expect, test } from "bun:test";
import { organizeCanvasNodes } from "@/lib/canvas/canvas-organize";
import { applyCanvasOperations, type CanvasSnapshot } from "@/lib/canvas/canvas-operation-contract";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

function node(id: string, type: CanvasNodeType, width = 120, height = 80, x = 0, y = 0, extra: Partial<CanvasNodeData> = {}): CanvasNodeData {
    return { id, type, title: id, position: { x, y }, width, height, metadata: {}, ...extra };
}

function apply(nodes: CanvasNodeData[], patches: Map<string, Partial<CanvasNodeData>>) {
    return nodes.map((item) => patches.has(item.id) ? { ...item, ...patches.get(item.id), position: patches.get(item.id)?.position || item.position } : item);
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

describe("organizeCanvasNodes", () => {
    test("16 same-media nodes form an exact 4 by 4 grid", () => {
        const nodes = Array.from({ length: 16 }, (_, i) => node(`image-${i}`, CanvasNodeType.Image, 100, 60, i * 3, i * 2));
        const result = organizeCanvasNodes(nodes, []);
        expect(result.sections).toHaveLength(1);
        expect(result.sections[0]).toMatchObject({ columns: 4, rows: 4 });
        const positions = apply(nodes, result.patches).map((item) => item.position);
        expect(new Set(positions.map((position) => position.x)).size).toBe(4);
        expect(new Set(positions.map((position) => position.y)).size).toBe(4);
    });

    test("mixed node sizes keep grid cells and section titles from overlapping", () => {
        const nodes = [node("a", CanvasNodeType.Video, 300, 180), node("b", CanvasNodeType.Video, 120, 240), node("c", CanvasNodeType.Video, 200, 90), node("d", CanvasNodeType.Video, 110, 100)];
        const result = organizeCanvasNodes(nodes, []);
        const placed = apply(nodes, result.patches);
        for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlaps({ ...placed[i]!.position, width: placed[i]!.width, height: placed[i]!.height }, { ...placed[j]!.position, width: placed[j]!.width, height: placed[j]!.height })).toBe(false);
        expect(placed[0]!.position.y).toBe(placed[1]!.position.y);
        expect(result.sections[0]!.bounds.y).toBeLessThanOrEqual(Math.min(...placed.map((item) => item.position.y)) - 32);
    });

    test("different media types become compact separate blocks", () => {
        const nodes = [node("t1", CanvasNodeType.Text), node("t2", CanvasNodeType.Script), node("i1", CanvasNodeType.Image), node("v1", CanvasNodeType.Video), node("a1", CanvasNodeType.Audio), node("a2", CanvasNodeType.Audio)];
        const result = organizeCanvasNodes(nodes, []);
        expect(result.sections.map((section) => section.key)).toEqual(["文字与规划", "图片与参考", "视频", "音频"]);
        expect(result.sections).toHaveLength(4);
        for (let i = 0; i < result.sections.length; i++) for (let j = i + 1; j < result.sections.length; j++) expect(overlaps(result.sections[i]!.bounds, result.sections[j]!.bounds)).toBe(false);
    });

    test("connections affect stable order without converting the result to one long row", () => {
        const nodes = Array.from({ length: 16 }, (_, i) => node(`n${i}`, CanvasNodeType.Text));
        const edges: CanvasConnection[] = nodes.slice(1).map((item, i) => ({ id: `e${i}`, fromNodeId: nodes[i]!.id, toNodeId: item.id }));
        const result = organizeCanvasNodes(nodes, edges);
        expect(result.sections[0]).toMatchObject({ columns: 4, rows: 4 });
        const placed = apply(nodes, result.patches);
        expect(placed[0]!.position.x).toBeLessThan(placed[1]!.position.x);
        expect(new Set(placed.map((item) => item.position.y)).size).toBe(4);
    });

    test("frames include children, resize to contain a new grid, and keep the frame first in patch order", () => {
        const frame = node("frame", CanvasNodeType.Frame, 220, 160, 100, 100, { metadata: { frame: { collapsed: false, expandedWidth: 220, expandedHeight: 160 } } });
        const children = Array.from({ length: 4 }, (_, i) => node(`child${i}`, CanvasNodeType.Image, 140, 90, 110 + i * 2, 150, { parentId: frame.id }));
        const result = organizeCanvasNodes([frame, ...children], []);
        expect(result.sections.some((section) => section.nodeIds.includes("child0"))).toBe(true);
        expect(result.patches.get("frame")!.width).toBeGreaterThan(frame.width);
        expect([...result.patches.keys()][0]).toBe("frame");
        for (const child of children) {
            const p = result.patches.get(child.id)!.position!;
            expect(p.x).toBeGreaterThanOrEqual(frame.position.x + 24);
            expect(p.y).toBeGreaterThanOrEqual(frame.position.y + 36 + 24);
        }
    });

    test("collapsed frame keeps collapsed state and collapsed dimensions while expanding its stored layout", () => {
        const frame = node("collapsed", CanvasNodeType.Frame, 240, 144, 0, 0, { metadata: { frame: { collapsed: true, expandedWidth: 100, expandedHeight: 100 } } });
        const child = node("inside", CanvasNodeType.Image, 240, 180, 10, 10, { parentId: frame.id });
        const result = organizeCanvasNodes([frame, child], []);
        expect(result.patches.get(frame.id)!.width).toBeUndefined();
        expect(result.patches.get(frame.id)!.metadata?.frame?.collapsed).toBe(true);
        expect(result.patches.get(frame.id)!.metadata?.frame?.expandedWidth).toBeGreaterThan(100);
    });

    test("moving a frame moves its descendants by the same world-space delta", () => {
        const frame = node("frame", CanvasNodeType.Frame, 300, 240, 0, 0, { metadata: { frame: { collapsed: false, expandedWidth: 300, expandedHeight: 240 } } });
        const child = node("inside", CanvasNodeType.Image, 80, 60, 20, 50, { parentId: frame.id });
        const blocker = node("blocker", CanvasNodeType.Text, 400, 300, 0, 0);
        const result = organizeCanvasNodes([frame, child, blocker], [], { nodeIds: [frame.id] });
        const nextFrame = result.patches.get(frame.id)!.position!;
        const nextChild = result.patches.get(child.id)!.position!;
        expect(nextChild.x - nextFrame.x).toBe(24);
        expect(nextChild.y - nextFrame.y).toBe(36 + 24 + 32);
    });

    test("locked nodes and frame subtrees with a locked descendant are preserved", () => {
        const frame = node("frame", CanvasNodeType.Frame, 300, 240, 0, 0, { metadata: { frame: { collapsed: false, expandedWidth: 300, expandedHeight: 240 } } });
        const child = node("child", CanvasNodeType.Image, 80, 60, 20, 50, { parentId: frame.id });
        const locked = node("locked", CanvasNodeType.Text, 80, 60, 30, 120, { parentId: frame.id, metadata: { locked: true } });
        const result = organizeCanvasNodes([frame, child, locked], []);
        expect(result.preservedNodeIds).toEqual(["frame", "child", "locked"]);
        expect(result.patches.has(frame.id)).toBe(false);
        expect(result.patches.has(child.id)).toBe(false);
    });

    test("selecting a child without its parent frame preserves it inside the unselected frame", () => {
        const frame = node("frame", CanvasNodeType.Frame, 300, 240, 0, 0, { metadata: { frame: { collapsed: false, expandedWidth: 300, expandedHeight: 240 } } });
        const child = node("child", CanvasNodeType.Image, 80, 60, 20, 50, { parentId: frame.id });
        const result = organizeCanvasNodes([frame, child], [], { nodeIds: [child.id] });
        expect(result.preservedNodeIds).toContain(child.id);
        expect(result.patches.has(child.id)).toBe(false);
    });

    test("a selected nested frame can organize its own contents without moving its unselected parent", () => {
        const outer = node("outer", CanvasNodeType.Frame, 900, 700, 0, 0, { metadata: { frame: { collapsed: false, expandedWidth: 900, expandedHeight: 700 } } });
        const inner = node("inner", CanvasNodeType.Frame, 400, 300, 80, 80, { parentId: outer.id, metadata: { frame: { collapsed: false, expandedWidth: 400, expandedHeight: 300 } } });
        const child = node("inner-child", CanvasNodeType.Image, 120, 80, 90, 130, { parentId: inner.id });
        const sibling = node("outer-sibling", CanvasNodeType.Text, 100, 60, 550, 80, { parentId: outer.id });
        const result = organizeCanvasNodes([outer, inner, child, sibling], [], { nodeIds: [inner.id] });
        expect(result.patches.has(outer.id)).toBe(false);
        expect(result.patches.get(child.id)?.position).toBeDefined();
        expect(result.preservedNodeIds).toContain(sibling.id);
    });

    test("repeat organization is idempotent and preserves IDs, dimensions, and edges", () => {
        const nodes = [node("a", CanvasNodeType.Image, 120, 80, 10, 20), node("b", CanvasNodeType.Video, 200, 100, 10, 20), node("c", CanvasNodeType.Text, 160, 70, 10, 20)];
        const edges: CanvasConnection[] = [{ id: "edge", fromNodeId: "a", toNodeId: "b" }];
        const first = organizeCanvasNodes(nodes, edges);
        const second = organizeCanvasNodes(apply(nodes, first.patches), edges);
        expect(second.patches.size).toBe(0);
        expect(nodes.map(({ id, width, height }) => ({ id, width, height }))).toEqual(nodes.map(({ id, width, height }) => ({ id, width, height })));
        expect(edges).toEqual([{ id: "edge", fromNodeId: "a", toNodeId: "b" }]);
    });

    test("empty and one-node canvases are safe; hidden batch children stay untouched", () => {
        expect(organizeCanvasNodes([], []).patches.size).toBe(0);
        const one = node("one", CanvasNodeType.Text);
        expect(organizeCanvasNodes([one], []).patches.size).toBe(0);
        const root = node("batch", CanvasNodeType.Image, 100, 80, 0, 0, { metadata: { imageBatchExpanded: false } });
        const hidden = node("hidden", CanvasNodeType.Image, 100, 80, 0, 0, { metadata: { batchRootId: root.id } });
        const result = organizeCanvasNodes([root, hidden], []);
        expect(result.preservedNodeIds).toContain(hidden.id);
        expect(result.patches.has(hidden.id)).toBe(false);
    });

    test("expanded frames fit final child sizes without growing on every organization", () => {
        const frame = node("frame", CanvasNodeType.Frame, 220, 160, 900, 500, { metadata: { frame: { collapsed: false, expandedWidth: 220, expandedHeight: 160 }, folder: { style: "default", createdAt: "2026-10-01" } } });
        const children = Array.from({ length: 4 }, (_, i) => node(`child-${i}`, CanvasNodeType.Image, 200, 100, 910, 550, { parentId: frame.id }));
        const neighbor = node("neighbor", CanvasNodeType.BatchTable, 180, 100, 0, 0);
        const initial = [frame, ...children, neighbor];
        const first = organizeCanvasNodes(initial, []);
        const placed = apply(initial, first.patches);
        const nextFrame = placed.find((item) => item.id === frame.id)!;
        const nextNeighbor = placed.find((item) => item.id === neighbor.id)!;
        expect(nextNeighbor.position.x).toBeGreaterThanOrEqual(nextFrame.position.x + nextFrame.width + 72);
        expect(nextFrame.metadata?.folder).toEqual(frame.metadata?.folder);
        for (const child of placed.filter((item) => item.parentId === frame.id)) {
            expect(child.position.x + child.width + 24).toBeLessThanOrEqual(nextFrame.position.x + nextFrame.width);
            expect(child.position.y + child.height + 24).toBeLessThanOrEqual(nextFrame.position.y + nextFrame.height);
        }
        expect(organizeCanvasNodes(placed, []).patches.size).toBe(0);
    });

    test("native parent movement and nested frame patches produce the same final positions", () => {
        const outer = node("outer", CanvasNodeType.Frame, 200, 160, 900, 700, { metadata: { frame: { collapsed: false, expandedWidth: 200, expandedHeight: 160 } } });
        const inner = node("inner", CanvasNodeType.Frame, 160, 120, 980, 780, { parentId: outer.id, metadata: { frame: { collapsed: false, expandedWidth: 160, expandedHeight: 120 } } });
        const child = node("child", CanvasNodeType.Image, 240, 180, 1000, 850, { parentId: inner.id });
        const text = node("plan", CanvasNodeType.Text, 120, 80, 0, 0);
        const initial = [outer, inner, child, text];
        const edges = [{ id: "reference", fromNodeId: child.id, toNodeId: text.id }];
        const organized = organizeCanvasNodes(initial, edges);
        const snapshot: CanvasSnapshot = { projectId: "test", title: "test", nodes: initial, connections: edges, selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } };
        const result = applyCanvasOperations(snapshot, [...organized.patches].map(([id, patch]) => ({ type: "update_node", id, patch })));
        expect(result.nodes).toEqual(apply(initial, organized.patches));
        expect(result.connections).toEqual(edges);
        expect(organizeCanvasNodes(result.nodes, edges).patches.size).toBe(0);
        for (const section of organized.sections) for (const id of section.nodeIds) {
            const item = result.nodes.find((entry) => entry.id === id)!;
            expect(item.position.x).toBeGreaterThanOrEqual(section.bounds.x);
            expect(item.position.y).toBeGreaterThanOrEqual(section.bounds.y + 32);
            expect(item.position.x + item.width).toBeLessThanOrEqual(section.bounds.x + section.bounds.width);
            expect(item.position.y + item.height).toBeLessThanOrEqual(section.bounds.y + section.bounds.height);
        }
    });

    test("unreachable parent cycles are fixed obstacles", () => {
        const a = node("a", CanvasNodeType.Frame, 300, 200, 0, 0, { parentId: "b" });
        const b = node("b", CanvasNodeType.Frame, 300, 200, 100, 0, { parentId: "a" });
        const moving = node("moving", CanvasNodeType.Image);
        const result = organizeCanvasNodes([a, b, moving], []);
        expect(result.preservedNodeIds).toEqual([a.id, b.id]);
        expect(result.patches.get(moving.id)?.position?.x).toBeGreaterThanOrEqual(472);
    });

    test("fractional world coordinates do not create repeated frame metadata updates", () => {
        const frame = node("frame", CanvasNodeType.Frame, 220.37, 160.38, 1316.67149, -1633.56788, { metadata: { frame: { collapsed: false, expandedWidth: 220.37, expandedHeight: 160.38 } } });
        const children = [node("a", CanvasNodeType.Image, 720, 404.3835616438356, 2.32, 33.57, { parentId: frame.id }), node("b", CanvasNodeType.Image, 720, 404.296875, 1, 2, { parentId: frame.id })];
        const text = node("text", CanvasNodeType.Text, 340, 240, -1239.54156, -1633.56788);
        const initial = [frame, ...children, text];
        const first = organizeCanvasNodes(initial, []);
        const second = organizeCanvasNodes(apply(initial, first.patches), []);
        expect(second.patches.size).toBe(0);
    });
});
