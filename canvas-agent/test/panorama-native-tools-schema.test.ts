import { describe, expect, test } from "bun:test";

import { toolInputSchemas } from "../src/schemas";

const context = { expectedCanvasId: "canvas-1", expectedRevision: 4, expectedStateHash: "hash" };

describe("native panorama tools schemas", () => {
    test("requires fresh canvas context and bounded native view values", () => {
        const schema = toolInputSchemas.canvas_set_panorama_view;
        expect(schema.safeParse({ ...context, nodeId: "pano-1", lon: 180, lat: -90, fov: 110 }).success).toBe(true);
        expect(schema.safeParse({ ...context, nodeId: "pano-1", lon: 181, lat: 0 }).success).toBe(false);
        expect(schema.safeParse({ ...context, nodeId: "pano-1", lon: 0, lat: 0, unexpected: true }).success).toBe(false);
    });

    test("capture is context guarded and render inspection is read-only selectable", () => {
        expect(toolInputSchemas.canvas_capture_panorama_view.safeParse({ ...context, nodeId: "pano-1" }).success).toBe(true);
        expect(toolInputSchemas.canvas_capture_panorama_view.safeParse({ ...context, nodeId: "pano-1", mode: "quad" }).success).toBe(true);
        expect(toolInputSchemas.canvas_capture_panorama_view.safeParse({ ...context, nodeId: "pano-1", mode: "fake" }).success).toBe(false);
        expect(toolInputSchemas.canvas_capture_panorama_view.safeParse({ nodeId: "pano-1" }).success).toBe(false);
        expect(toolInputSchemas.canvas_inspect_node_render.safeParse({ canvasId: "canvas-1", nodeId: "chart-1" }).success).toBe(true);
    });
});
