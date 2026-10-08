export function normalizeCompareSplitPercentage(value: unknown) {
    if (typeof value !== "number" || !Number.isFinite(value)) return 50;
    return Math.max(0, Math.min(100, value));
}

export function compareSplitPercentageFromPointer(clientX: number, left: number, width: number) {
    if (!Number.isFinite(clientX) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 0) return undefined;
    return normalizeCompareSplitPercentage(((clientX - left) / width) * 100);
}
