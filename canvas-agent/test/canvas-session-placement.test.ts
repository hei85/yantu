import { describe, expect, test } from "bun:test";

import { resolveGenerationPlacement } from "../src/canvas-session";

const node = (id: string, x: number, y: number, width = 340, height = 240) => ({
    id,
    type: "text" as const,
    title: id,
    position: { x, y },
    width,
    height,
});

describe("generation node placement", () => {
    test("有锚点节点时贴着它右侧生成，不再飞到画布最右端", () => {
        const state = { nodes: [node("anchor", 0, 0, 720, 405)], connections: [] } as never;
        const placement = resolveGenerationPlacement({}, state, ["anchor"]);
        expect(placement.x).toBe(880);
        expect(placement.y).toBe(0);
    });

    test("右侧已被占用时向下找空位，避免重叠", () => {
        const state = {
            nodes: [
                node("anchor", 0, 0, 720, 405),
                node("busy", 880, 0, 720, 405),
            ],
            connections: [],
        } as never;
        const placement = resolveGenerationPlacement({}, state, ["anchor"]);
        expect(placement.x).toBe(880);
        expect(placement.y).toBeGreaterThanOrEqual(445);
    });

    test("显式坐标优先，没有锚点时退回画布光标", () => {
        const state = { nodes: [node("anchor", 0, 0)], connections: [] } as never;
        expect(resolveGenerationPlacement({ x: 123, y: 456 }, state, ["anchor"])).toEqual({ x: 123, y: 456 });
        const fallback = resolveGenerationPlacement({}, state, []);
        expect(fallback.y).toBe(0);
        expect(Number.isFinite(fallback.x)).toBe(true);
    });
});
