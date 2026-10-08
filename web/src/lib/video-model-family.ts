/** Match a user-requested video model family against the configured model ID. */
export function videoModelMatchesFamily(model: string, family: string): boolean {
    const normalizedFamily = normalizeFamily(family);
    if (!normalizedFamily) return true;
    const modelKey = model.split("::").pop() || model;
    const normalizedModel = normalizeFamily(modelKey);
    return normalizedModel === normalizedFamily || normalizedModel.startsWith(`${normalizedFamily}_`);
}

export function normalizeFamily(value: string): string {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return normalized === "h3" ? "minimax_h3" : normalized;
}
