import { http } from "@/services/api/request";

export type ProductionRunStatus =
    | "planning"
    | "running"
    | "repairing"
    | "rendering"
    | "verifying"
    | "waiting_external"
    | "needs_input"
    | "waiting_agent"
    | "paused"
    | "completed"
    | "failed"
    | "cancelled";

export type ProductionStepInput = {
    stepKey: string;
    kind: string;
    sceneId?: string;
    shotId?: string;
    storyboardRowId?: string;
    segmentId?: string;
    segmentOrder?: number;
    trackId?: string;
    dependsOn?: string[];
    inputFingerprint?: string;
    selectedStrategyId?: string;
    estimatedCostMicros?: number;
};

export type ProductionStep = ProductionStepInput & {
    id: string;
    runId: string;
    status: string;
    attemptCount: number;
    revision: number;
    blockingReason?: string;
    outputArtifactIds?: string[];
    createdAt: string;
    updatedAt: string;
};

export type ProductionAttempt = {
    id: string;
    runId: string;
    stepId: string;
    creationSubmissionId?: string;
    attemptNumber: number;
    idempotencyKey: string;
    requestHash: string;
    retryOf?: string;
    capabilityRevision: string;
    providerTaskId?: string;
    generationTaskId?: string;
    state: string;
    costReservationId?: string;
    errorCode?: string;
    createdAt: string;
    updatedAt: string;
};

export type ProductionRun = {
    id: string;
    domainProjectId?: string;
    canvasId?: string;
    creationRunId?: string;
    workflowInstanceId?: string;
    status: ProductionRunStatus | string;
    currentStage: string;
    revision: number;
    brief: Record<string, unknown>;
    deliveryContract: ProductionDeliveryContract;
    plan: Record<string, unknown>;
    policy: Record<string, unknown>;
    quality: Record<string, unknown>;
    audioMode: "NATIVE_AUDIO" | "REBUILD_AUDIO";
    targetDurationMs: number;
    targetFpsNumerator: number;
    targetFpsDenominator: number;
    budgetLimit: number;
    spent: number;
    reserved: number;
    finalResourceId?: string;
    lastEventSequence: number;
    steps: ProductionStep[];
    attempts: ProductionAttempt[];
    events?: Array<{ id: string; sequence: number; type: string; objectId?: string; objectRevision: number; payloadJson: string; createdAt: string }>;
    createdAt: string;
    updatedAt: string;
};

export type ProductionDeliveryContract = {
    targetDurationMs: number;
    targetAspectRatio: string;
    minWidth?: number;
    minHeight?: number;
    maxWidth?: number;
    maxHeight?: number;
    durationToleranceMs: number;
    requireVideo: true;
    requireAudio: boolean;
    requireSubtitle: boolean;
    requireFullDecode: true;
    briefVersion?: string;
    approvedChangeVersion?: string;
};

export type ProductionDeliveryCheck = {
    name: string;
    originalRequirement: unknown;
    effectiveRequirement: unknown;
    measured: unknown;
    status: "passed" | "failed" | "uncertain";
    reason: string;
};

export type ProductionDeliveryVerificationRequest = {
    expectedRevision: number;
    resourceId: string;
    expectedDurationMs?: number;
    expectedAspectRatio?: string;
    expectedWidth?: number;
    expectedHeight?: number;
    requireVideo?: boolean;
    requireAudio?: boolean;
    requireSubtitle?: boolean;
};

export type ProductionTaskRequest = {
    projectId?: string;
    type: string;
    operation?: string;
    prompt: string;
    provider?: string;
    model?: string;
    logicalModelId?: string;
    input?: Record<string, unknown>;
};

export type ProductionSubmitRequest = {
    expectedRevision: number;
    stepId: string;
    idempotencyKey: string;
    capabilityRevision: string;
    estimatedCostMicros: number;
    retryOf?: string;
    task: ProductionTaskRequest;
};

export type ProductionStepResultRequest = {
    expectedRevision: number;
    stepId: string;
    evidence: Record<string, unknown>;
};

const path = (id: string) => `/production-runs/${encodeURIComponent(id)}`;

export const productionRuns = {
    list: (signal?: AbortSignal) => http.get<{ runs: ProductionRun[] }>("/production-runs", { signal }),
    create: (input: {
        clientKey: string;
        domainProjectId?: string;
        canvasId?: string;
        creationRunId?: string;
        workflowInstanceId?: string;
        brief?: Record<string, unknown>;
        deliveryContract?: Partial<ProductionDeliveryContract>;
        plan?: Record<string, unknown>;
        policy?: Record<string, unknown>;
        quality?: Record<string, unknown>;
        audioMode?: "NATIVE_AUDIO" | "REBUILD_AUDIO";
        targetDurationMs?: number;
        targetFpsNumerator?: number;
        targetFpsDenominator?: number;
        budgetLimit?: number;
        steps?: ProductionStepInput[];
    }, signal?: AbortSignal) => http.post<ProductionRun>("/production-runs", input, { signal }),
    get: (id: string, after?: number, signal?: AbortSignal) => http.get<ProductionRun>(path(id), { params: after ? { after } : undefined, signal }),
    updatePlan: (id: string, input: { expectedRevision: number; plan?: Record<string, unknown>; steps?: ProductionStepInput[] }, signal?: AbortSignal) =>
        http.patch<ProductionRun>(`${path(id)}/plan`, input, { signal }),
    authorize: (id: string, input: { expectedRevision: number; policy: Record<string, unknown> }, signal?: AbortSignal) =>
        http.post<ProductionRun>(`${path(id)}/authorize`, input, { signal }),
    action: (id: string, input: { expectedRevision: number; action: "pause" | "resume" | "cancel"; reason?: string }, signal?: AbortSignal) =>
        http.post<ProductionRun>(`${path(id)}/actions`, input, { signal }),
    submitRenderStep: (id: string, input: { expectedRevision: number; stepId: string; idempotencyKey: string; retryOf?: string; timeline: unknown }, signal?: AbortSignal) =>
        http.post<{ runRevision: number; stepId: string; attempt: ProductionAttempt; task: unknown; idempotent: boolean }>(`${path(id)}/steps/render`, input, { signal }),
    complete: (id: string, input: { expectedRevision: number; resourceId: string }, signal?: AbortSignal) =>
        http.post<ProductionRun>(`${path(id)}/complete`, input, { signal }),
    verify: (id: string, input: ProductionDeliveryVerificationRequest, signal?: AbortSignal) => http.post<{
        deliveryStatus: "passed" | "failed" | "uncertain";
        checks: ProductionDeliveryCheck[];
        media?: unknown;
        completed: boolean;
        run?: ProductionRun;
    }>(`${path(id)}/verify`, input, { signal }),
    submitStep: (id: string, input: ProductionSubmitRequest, signal?: AbortSignal) =>
        http.post<{ runRevision: number; stepId: string; attempt: ProductionAttempt; task: unknown; idempotent: boolean }>(`${path(id)}/steps/submit`, input, { signal }),
    recordStepResult: (id: string, input: ProductionStepResultRequest, signal?: AbortSignal) =>
        http.post<ProductionRun>(`${path(id)}/steps/result`, input, { signal }),
    tasks: (id: string, signal?: AbortSignal) =>
        http.get<{ attempts: ProductionAttempt[]; tasks: unknown[] }>(`${path(id)}/tasks`, { signal }),
};
