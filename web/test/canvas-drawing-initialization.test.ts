import { describe, expect, test } from "bun:test";

import { initializeEmptyCanvasDrawing, startEmptyCanvasDrawingInitialization, waitForCanvasDrawingInitialization, type CanvasDrawingInitializationStorage, type CanvasDrawingSnapshot } from "../src/lib/canvas/canvas-drawing-storage";

function storageWith(initial: CanvasDrawingSnapshot | null = null) {
    let saved = initial;
    let saves = 0;
    let lastSnapshot: unknown;
    const storage: CanvasDrawingInitializationStorage = {
        load: async () => saved,
        save: async (_projectId, _drawingId, engine, snapshot) => {
            saves += 1;
            lastSnapshot = snapshot;
            const result: CanvasDrawingSnapshot = {
                version: 2,
                engine,
                snapshot,
                revision: 1,
                updatedAt: "2026-09-30T00:00:00.000Z",
                shapeCount: 0,
                pageCount: 1,
            };
            saved = result;
            return result;
        },
    };
    return { storage, get saves() { return saves; }, get saved() { return saved; }, get lastSnapshot() { return lastSnapshot; } };
}

describe("canvas drawing initialization", () => {
    test("persists a real empty Excalidraw document at revision one", async () => {
        const harness = storageWith();
        const saved = await initializeEmptyCanvasDrawing("canvas-1", "drawing-1", "excalidraw", harness.storage);

        expect(harness.saves).toBe(1);
        expect(saved).toMatchObject({ version: 2, engine: "excalidraw", revision: 1, shapeCount: 0, pageCount: 1 });
        expect(saved.snapshot).toEqual({ elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} });
        expect(harness.lastSnapshot).toEqual(saved.snapshot);
    });

    test("preserves an existing drawing and rejects a node/document engine mismatch", async () => {
        const existing: CanvasDrawingSnapshot = {
            version: 2,
            engine: "excalidraw",
            snapshot: { elements: [{ id: "existing-shape" }], appState: {}, files: {} },
            revision: 4,
            updatedAt: "2026-09-29T00:00:00.000Z",
            shapeCount: 1,
            pageCount: 1,
        };
        const harness = storageWith(existing);

        await expect(initializeEmptyCanvasDrawing("canvas-1", "drawing-1", "excalidraw", harness.storage)).resolves.toBe(existing);
        expect(harness.saves).toBe(0);
        await expect(initializeEmptyCanvasDrawing("canvas-1", "drawing-1", "tldraw", harness.storage)).rejects.toThrow("但已保存文档属于 excalidraw");
        expect(harness.saves).toBe(0);
    });

    test("creates a valid empty tldraw document for licensed-engine canvases", async () => {
        const harness = storageWith();
        const saved = await initializeEmptyCanvasDrawing("canvas-2", "drawing-2", "tldraw", harness.storage);
        const snapshot = saved.snapshot as { store?: Record<string, unknown> };

        expect(harness.saves).toBe(1);
        expect(saved).toMatchObject({ engine: "tldraw", revision: 1, shapeCount: 0, pageCount: 1 });
        expect(snapshot.store?.["page:main"]).toMatchObject({ typeName: "page", name: "Page 1" });
    });

    test("waits for an in-flight document write before reporting initialized", async () => {
        let finishLoad: ((value: CanvasDrawingSnapshot | null) => void) | undefined;
        const base = storageWith();
        let saves = 0;
        let isFirstLoad = true;
        const storage: CanvasDrawingInitializationStorage = {
            load: () => isFirstLoad
                ? (isFirstLoad = false, new Promise((resolve) => { finishLoad = resolve; }))
                : base.storage.load("canvas-race", "drawing-race"),
            save: async (...args) => { saves += 1; return base.storage.save(...args); },
        };
        const creation = startEmptyCanvasDrawingInitialization("canvas-race", "drawing-race", "excalidraw", storage);
        let waiterResolved = false;
        const waiter = waitForCanvasDrawingInitialization("canvas-race", "drawing-race", storage).then((saved) => {
            waiterResolved = true;
            return saved;
        });

        await Promise.resolve();
        expect(waiterResolved).toBe(false);
        finishLoad?.(null);
        const [created, waited] = await Promise.all([creation, waiter]);
        expect(waited).toBe(created);
        expect(saves).toBe(1);
    });

    test("does not invent a blank drawing when no stored document exists", async () => {
        const harness = storageWith();
        await expect(waitForCanvasDrawingInitialization("canvas-missing", "drawing-missing", harness.storage)).rejects.toThrow("绘图文档初始化未持久化");
        expect(harness.saves).toBe(0);
    });
});
