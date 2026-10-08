import { describe, expect, test } from "bun:test";

import { compareSplitPercentageFromPointer, normalizeCompareSplitPercentage } from "../src/lib/canvas/canvas-compare-split";

describe("canvas compare split position", () => {
    test("defaults to 50 and clamps persisted metadata to the supported range", () => {
        expect(normalizeCompareSplitPercentage(undefined)).toBe(50);
        expect(normalizeCompareSplitPercentage(Number.NaN)).toBe(50);
        expect(normalizeCompareSplitPercentage(-10)).toBe(0);
        expect(normalizeCompareSplitPercentage(37.5)).toBe(37.5);
        expect(normalizeCompareSplitPercentage(110)).toBe(100);
    });

    test("maps pointer position to a bounded percentage", () => {
        expect(compareSplitPercentageFromPointer(150, 100, 100)).toBe(50);
        expect(compareSplitPercentageFromPointer(300, 100, 100)).toBe(100);
        expect(compareSplitPercentageFromPointer(50, 100, 100)).toBe(0);
        expect(compareSplitPercentageFromPointer(100, 100, 0)).toBeUndefined();
    });
});
