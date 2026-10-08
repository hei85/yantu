import { describe, expect, test } from "bun:test";

import { ensureBackendCanvasProjectLink } from "@/services/api/project-agent-tools";
import type { CanvasUnitLink } from "@/services/api/projects";

describe("agent project bootstrap canvas persistence", () => {
    test("persists a project-level backend link when the browser canvas is only locally bound", async () => {
        const calls: Array<{ projectId: string; input: { canvasId: string; unitId?: string; role?: string } }> = [];
        await ensureBackendCanvasProjectLink("project-1", "canvas-1", [], async (projectId, input) => {
            calls.push({ projectId, input });
            return { link: { id: "link-1", projectId, canvasId: input.canvasId, unitId: input.unitId || "", role: input.role || "project" } };
        });
        expect(calls).toEqual([{ projectId: "project-1", input: { canvasId: "canvas-1", role: "project" } }]);
    });

    test("does not create a duplicate backend link when the project already owns the canvas", async () => {
        let called = false;
        const existing: CanvasUnitLink[] = [{
            id: "link-1", projectId: "project-1", canvasId: "canvas-1", unitId: "", role: "project", createdAt: "2026-10-01T00:00:00Z",
        }];
        await ensureBackendCanvasProjectLink("project-1", "canvas-1", existing, async () => {
            called = true;
            throw new Error("duplicate link request");
        });
        expect(called).toBe(false);
    });
});
