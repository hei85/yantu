import { describe, expect, test } from "bun:test";

import { toolInputSchemas } from "../src/schemas";

describe("canvas_update_director_shot camera binding schema", () => {
    test("accepts a nonempty cameraId in the shot patch", () => {
        const parsed = toolInputSchemas.canvas_update_director_shot.safeParse({
            sceneId: "scene-1",
            shotId: "shot-1",
            expectedCanvasId: "canvas-1",
            expectedRevision: 0,
            expectedStateHash: "state-hash",
            expectedSceneHash: "hash-1",
            patch: { cameraId: "camera-1" },
        });
        expect(parsed.success).toBe(true);
    });

    test("rejects an empty cameraId", () => {
        const parsed = toolInputSchemas.canvas_update_director_shot.safeParse({
            sceneId: "scene-1",
            shotId: "shot-1",
            expectedCanvasId: "canvas-1",
            expectedRevision: 0,
            expectedStateHash: "state-hash",
            expectedSceneHash: "hash-1",
            patch: { cameraId: "" },
        });
        expect(parsed.success).toBe(false);
    });
});
