export type CanvasGenerationSubmissionRace<T> =
    | { kind: "submitted"; value: T }
    | { kind: "completed" };

/** Resolve when a long-running generation task is accepted, while preserving early failures. */
export function waitForCanvasGenerationSubmission<T>(generation: Promise<unknown>, submitted: Promise<T>): Promise<CanvasGenerationSubmissionRace<T>> {
    return Promise.race([
        submitted.then((value) => ({ kind: "submitted" as const, value })),
        generation.then(() => ({ kind: "completed" as const })),
    ]);
}
