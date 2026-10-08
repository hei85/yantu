const audioCapabilityFields = [
    "tts",
    "voiceDesign",
    "voiceReference",
    "ambientSound",
    "soundEffects",
    "music",
    "speechRecognition",
    "alignment",
] as const;

const audioCapabilityStatuses = new Set(["configured", "unsupported", "unknown"]);

export function normalizeFilmModelCatalog(value: unknown) {
    if (!isRecord(value) || !Array.isArray(value.models)) return value;
    return {
        ...value,
        models: value.models.map((candidate) => {
            if (!isRecord(candidate) || candidate.capability !== "audio") return candidate;
            const supports = isRecord(candidate.supports) ? candidate.supports : {};
            const capabilities = isRecord(supports.audioCapabilities) ? supports.audioCapabilities : {};
            const audioCapabilities = { ...capabilities };
            for (const field of audioCapabilityFields) {
                if (!audioCapabilityStatuses.has(String(audioCapabilities[field] ?? ""))) audioCapabilities[field] = "unknown";
            }
            return { ...candidate, supports: { ...supports, audioCapabilities } };
        }),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
