import { describe, expect, test } from "bun:test";

import { toolInputSchemas } from "../src/schemas";

describe("canvas_export_color_grade schema", () => {
    test("requires a target node and fresh canvas state", () => {
        const schema = toolInputSchemas.canvas_export_color_grade;
        expect(schema.safeParse({ nodeId: "grade-1", expectedCanvasId: "canvas-1", expectedRevision: 2, expectedStateHash: "state-hash" }).success).toBe(true);
        expect(schema.safeParse({ nodeId: "grade-1", expectedCanvasId: "canvas-1", expectedRevision: 2 }).success).toBe(false);
    });
});
