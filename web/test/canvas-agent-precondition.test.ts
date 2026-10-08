import { describe, expect, test } from "bun:test";

import { canvasToolPreconditionConflict } from "@/lib/canvas/canvas-agent-precondition";

describe("canvas tool precondition", () => {
    test("flushes pending state syncs before comparing runtime refs", async () => {
        const refs = { revision: 10, stateHash: "hash-before" };
        const conflict = await canvasToolPreconditionConflict({
            // 连续 MCP 写入时，运行时 revision 已经前进，而本地 refs 还停在上一次同步结果。
            flushPendingStateSync: async () => {
                refs.revision = 11;
                refs.stateHash = "hash-after";
            },
            readRuntimeRefs: () => ({ ...refs }),
            expectedRevision: 11,
            expectedStateHash: "hash-after",
        });
        expect(conflict).toBeNull();
    });

    test("still reports a conflict for a genuinely changed canvas", async () => {
        const refs = { revision: 10, stateHash: "hash-before" };
        const conflict = await canvasToolPreconditionConflict({
            flushPendingStateSync: async () => undefined,
            readRuntimeRefs: () => ({ ...refs }),
            expectedRevision: 11,
            expectedStateHash: "hash-after",
        });
        expect(conflict).toBe("revision");
    });

    test("keeps the local verdict when the pending sync fails", async () => {
        const refs = { revision: 11, stateHash: "hash-after" };
        const conflict = await canvasToolPreconditionConflict({
            flushPendingStateSync: async () => { throw new Error("offline"); },
            readRuntimeRefs: () => ({ ...refs }),
            expectedRevision: 11,
            expectedStateHash: "hash-after",
        });
        expect(conflict).toBeNull();
    });
});
