import { describe, expect, test } from "bun:test";

import { waitForCanvasMediaNodeState, type CanvasMediaNodeState } from "../src/lib/canvas/canvas-media-node-persistence";

describe("canvas media node persistence", () => {
    test("waits for native replacement state before the caller flushes storage", async () => {
        let reads = 0;
        const oldNode: CanvasMediaNodeState = { id: "image-1", type: "image", metadata: { assetId: "old-asset" } };
        const replacement: CanvasMediaNodeState = { id: "image-1", type: "image", metadata: { assetId: "new-asset" } };

        const persisted = await waitForCanvasMediaNodeState(() => {
            reads += 1;
            return reads < 3 ? [oldNode] : [replacement];
        }, { nodeId: "image-1", nodeType: "image", assetId: "new-asset" }, { attempts: 5, intervalMs: 0 });

        expect(persisted).toBe(true);
        expect(reads).toBe(3);
    });

    test("does not confirm the replacement for another node, media type, or asset", async () => {
        const persisted = await waitForCanvasMediaNodeState(() => [
            { id: "image-2", type: "image", metadata: { assetId: "new-asset" } },
            { id: "image-1", type: "video", metadata: { assetId: "new-asset" } },
            { id: "image-1", type: "image", metadata: { assetId: "old-asset" } },
        ], { nodeId: "image-1", nodeType: "image", assetId: "new-asset" }, { attempts: 2, intervalMs: 0 });

        expect(persisted).toBe(false);
    });
});
