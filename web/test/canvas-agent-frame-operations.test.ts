import { describe, expect, test } from "bun:test";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { createCanvasAgentFrameOperations } from "../src/pages/canvas/canvas-agent-frame-operations";

function node(id: string, type: CanvasNodeData["type"], extra: Partial<CanvasNodeData> = {}): CanvasNodeData {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {}, ...extra };
}

describe("canvas Agent Frame operations", () => {
    test("refuses linked-folder moves until asset synchronization is wired", async () => {
        const nodes: CanvasNodeData[] = [
            node("image", CanvasNodeType.Image, { metadata: { content: "data:image/png;base64,AA==" } }),
            node("linked", CanvasNodeType.Frame, { metadata: { folder: { assetFolderId: "remote-folder" }, frame: { collapsed: true } } }),
        ];
        let commits = 0;
        const ops = createCanvasAgentFrameOperations({
            nodesRef: { current: nodes },
            createFolder: () => undefined,
            createStoryboardGroup: () => undefined,
            createReferenceGroup: () => undefined,
            commitNodes: () => { commits += 1; },
        });

        await expect(ops.moveNodes(["image"], "linked")).rejects.toThrow("ensureCanvasNodeAsset");
        expect(commits).toBe(0);
        expect(nodes[0].parentId).toBeUndefined();
    });

    test("rejects locked nodes and returns the native drop readback", async () => {
        const initial: CanvasNodeData[] = [
            node("image", CanvasNodeType.Image, { metadata: { content: "data:image/png;base64,AA==", locked: true } }),
            node("folder", CanvasNodeType.Frame, { metadata: { folder: {}, frame: { collapsed: true } } }),
        ];
        const ref = { current: initial };
        const ops = createCanvasAgentFrameOperations({
            nodesRef: ref,
            createFolder: () => undefined,
            createStoryboardGroup: () => undefined,
            createReferenceGroup: () => undefined,
            commitNodes: (next) => { ref.current = next; },
        });
        await expect(ops.moveNodes(["image"], "folder")).rejects.toThrow("已锁定");
        expect(ref.current[0].parentId).toBeUndefined();
    });
});
