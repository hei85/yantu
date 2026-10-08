const DIALOGUE_LABEL = /不适合对白对话|适合对白对话(?:（需音频）)?/g;

function records(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value)
        ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        : [];
}

function dialogueEntry(observed: unknown) {
    return records(observed).find((item) => item.feature === "dialogue");
}

export function videoDialogueObservation(observed: unknown) {
    const details = dialogueEntry(observed)?.details;
    return details && typeof details === "object" && !Array.isArray(details)
        ? details as Record<string, unknown>
        : undefined;
}

export function videoDialogueSummary(observed: unknown, description = "") {
    const reason = dialogueEntry(observed)?.reason;
    if (typeof reason === "string" && reason.trim()) return reason.trim();
    return description.match(DIALOGUE_LABEL)?.[0] || "";
}

export function stripVideoDialogueSummary(description: string, summary: string) {
    return summary
        ? description.replace(DIALOGUE_LABEL, "").replace(/\s*[·｜|]\s*[·｜|]\s*/g, " · ").replace(/^[\s·｜|]+|[\s·｜|]+$/g, "").trim()
        : description;
}
