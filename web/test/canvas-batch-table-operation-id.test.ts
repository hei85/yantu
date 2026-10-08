import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

const source = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-batch-table.ts"), "utf8");

test("batch table recovery validates the requested row IDs against the saved operation", () => {
    expect(source).toContain("assertBatchOperationRowIdsMatch(requestedRowIds, previousBatch.items.map((item) => item.rowId))");
    expect(source).toMatch(/export function assertBatchOperationRowIdsMatch[\s\S]*?requestedRowIds[\s\S]*?batchRowIds[\s\S]*?throw new Error/);
});
