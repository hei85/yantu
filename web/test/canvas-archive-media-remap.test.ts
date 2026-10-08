import { expect, test } from "bun:test";

import { remapArchiveProjectMedia } from "@/lib/canvas/canvas-archive-media-remap";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

test("ZIP 导入保留文本文件正文并替换真实媒体引用", () => {
    const project = {
        nodes: [
            { id: "text", type: "text", metadata: { storageKey: "file:old", content: "这是原文件正文" } },
            { id: "image", type: "image", metadata: { storageKey: "image:old", content: "blob:old-image" } },
        ],
        timeline: {
            clips: [{ directMedia: { kind: "image", storageKey: "image:old", url: "blob:old-image", assetId: "old-asset" } }],
        },
        chatSessions: [{ attachment: { kind: "image", storageKey: "image:old", content: "blob:old-image" } }],
    } as unknown as CanvasProject;
    const mappings = new Map([
        ["file:old", { storageKey: "resource:new-text", url: "/api/resources/new-text/file" }],
        ["image:old", { storageKey: "resource:new-image", url: "/api/resources/new-image/file" }],
    ]);

    const imported = remapArchiveProjectMedia(project, mappings, new Map());
    expect(imported.nodes[0].metadata?.storageKey).toBe("resource:new-text");
    expect(imported.nodes[0].metadata?.content).toBe("这是原文件正文");
    expect(imported.nodes[1].metadata?.storageKey).toBe("resource:new-image");
    expect(imported.nodes[1].metadata?.content).toBe("/api/resources/new-image/file");
    expect(imported.timeline?.clips[0].directMedia?.storageKey).toBe("resource:new-image");
    expect(imported.timeline?.clips[0].directMedia?.assetId).toBeUndefined();
    expect((imported.chatSessions[0] as unknown as { attachment: { content: string } }).attachment.content).toBe("/api/resources/new-image/file");
});
