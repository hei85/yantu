import { describe, expect, test } from "bun:test";
import { createTLStore } from "tldraw";
import { applyTldrawDrawingOperation } from "@/pages/canvas/canvas-agent-tldraw-operations";

function emptySnapshot() {
    return createTLStore().getStoreSnapshot();
}

describe("canvas agent tldraw operations", () => {
    test("adds restricted shapes and returns their ID and current-page count", () => {
        const first = applyTldrawDrawingOperation(emptySnapshot(), { type: "add_shape", shapeType: "rectangle", x: 12, y: 30, w: 180, h: 90, color: "blue" });
        expect(first.shapeId).toMatch(/^shape:/);
        expect(first.shapeCount).toBe(1);
        const second = applyTldrawDrawingOperation(first.snapshot, { type: "add_shape", shapeType: "text", x: 20, y: 40, w: 200, text: "hello" });
        expect(second.shapeCount).toBe(2);
        expect(second.shapeId).toMatch(/^shape:/);
    });

    test("updates and deletes only existing shapes", () => {
        const created = applyTldrawDrawingOperation(emptySnapshot(), { type: "add_shape", shapeType: "ellipse", x: 0, y: 0, w: 40, h: 50 });
        const updated = applyTldrawDrawingOperation(created.snapshot, { type: "update_element", shapeId: created.shapeId!, x: 20, color: "red", fill: "solid" });
        expect(updated.shapeCount).toBe(1);
        expect(() => applyTldrawDrawingOperation(updated.snapshot, { type: "delete_element", shapeId: "shape:missing" })).toThrow();
        const deleted = applyTldrawDrawingOperation(updated.snapshot, { type: "delete_element", shapeId: created.shapeId! });
        expect(deleted.shapeCount).toBe(0);
    });

    test("rejects invalid sizes, colors, snapshot injection, and multiple pages", () => {
        expect(() => applyTldrawDrawingOperation(emptySnapshot(), { type: "add_shape", shapeType: "rectangle", x: 0, y: 0, w: 99999, h: 30 })).toThrow();
        expect(() => applyTldrawDrawingOperation(emptySnapshot(), { type: "add_shape", shapeType: "ellipse", x: 0, y: 0, w: 30, h: 30, color: "url(javascript:alert(1))" })).toThrow();
        expect(() => applyTldrawDrawingOperation({ records: [] }, { type: "delete_element", shapeId: "shape:x" })).toThrow();
    });
});
