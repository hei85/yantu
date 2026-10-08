import type { CanvasSnapshot } from "./types.js";

type RecordValue = Record<string, unknown>;

/**
 * Resolve ProductionRun media reuse against the MCP runtime's current canvas snapshot.
 * The canvas Script row is the authoritative source for task, node and resource bindings.
 */
export function hydrateFilmPlanFromCanvasStoryboard(input: RecordValue, canvasState: CanvasSnapshot | null) {
    if (!canvasState?.nodes?.length) return input;
    const plan = asRecord(input.plan);
    const productionSpec = asRecord(plan?.productionSpec);
    const plannedRows = productionSpec?.storyboardRows;
    if (!plan || !productionSpec || !Array.isArray(plannedRows)) return input;

    const sourceRows = new Map<string, RecordValue[]>();
    for (const node of canvasState.nodes) {
        if (node.type !== "script") continue;
        const storyboard = asRecord(node.metadata?.storyboard);
        const rows = Array.isArray(storyboard?.rows) ? storyboard.rows : [];
        for (const rawRow of rows) {
            const row = asRecord(rawRow);
            const rowId = stringValue(row?.id);
            if (!rowId || !row) continue;
            const matches = sourceRows.get(rowId) || [];
            matches.push(row);
            sourceRows.set(rowId, matches);
        }
    }

    const storyboardRows = plannedRows.map((rawRow) => {
        const row = asRecord(rawRow);
        if (!row) return rawRow;
        const rowId = stringValue(row.rowId || row.id);
        if (!rowId) return rawRow;
        const matches = sourceRows.get(rowId) || [];
        if (matches.length > 1) throw new Error(`ProductionSpec 分镜 ${rowId} 在当前画布有多个 Script 来源，不能猜测媒体绑定`);
        const sourceRow = matches[0];
        if (!sourceRow) return rawRow;

        const sourceBindings = (Array.isArray(sourceRow.segmentBindings) ? sourceRow.segmentBindings : [])
            .map(asRecord)
            .filter((binding): binding is RecordValue => Boolean(binding));
        const sourceBindingsById = new Map<string, RecordValue>();
        for (const binding of sourceBindings) {
            const segmentId = stringValue(binding.segmentId);
            if (segmentId) sourceBindingsById.set(segmentId, binding);
        }
        const normalizedBindings = sourceBindings.map(normalizeBinding);
        const suppliedBindings: unknown[] = Array.isArray(row.segmentBindings) ? row.segmentBindings : [];
        const segmentBindings = suppliedBindings.length
            ? suppliedBindings.map((rawBinding) => {
                const binding = asRecord(rawBinding);
                if (!binding) return rawBinding;
                const segmentId = stringValue(binding.segmentId);
                const authoritative = sourceBindingsById.get(segmentId);
                if (!authoritative) return rawBinding;
                assertBindingMatches(rowId, segmentId, binding, authoritative);
                return { ...binding, ...normalizeBinding(authoritative) };
            })
            : normalizedBindings;

        const segments = Array.isArray(row.segments)
            ? row.segments.map((rawSegment) => {
                const segment = asRecord(rawSegment);
                if (!segment) return rawSegment;
                const segmentId = stringValue(segment.segmentId);
                const binding = sourceBindingsById.get(segmentId);
                if (!isReusable(binding)) return rawSegment;
                const existingMedia = {
                    resourceId: stringValue(binding?.resourceId),
                    ...(stringValue(binding?.taskId) ? { sourceTaskId: stringValue(binding?.taskId) } : {}),
                    sourceNodeId: stringValue(binding?.videoNodeId),
                };
                const suppliedMedia = asRecord(segment.existingMedia);
                if (suppliedMedia) {
                    for (const [key, expected] of Object.entries(existingMedia)) {
                        const supplied = stringValue(suppliedMedia[key]);
                        if (supplied && supplied !== expected) throw new Error(`ProductionSpec 分镜 ${rowId} 片段 ${segmentId} 的现有媒体与当前画布 SegmentBinding 不一致`);
                    }
                }
                return { ...segment, existingMedia };
            })
            : undefined;

        const sourceVideoNodeId = stringValue(sourceRow.videoNodeId);
        const suppliedVideoNodeId = stringValue(row.videoNodeId);
        if (sourceVideoNodeId && suppliedVideoNodeId && sourceVideoNodeId !== suppliedVideoNodeId) {
            throw new Error(`ProductionSpec 分镜 ${rowId} 的 videoNodeId 与当前画布 Script 不一致`);
        }
        const sourceImageNodeId = stringValue(sourceRow.imageNodeId);
        const suppliedImageNodeId = stringValue(row.imageNodeId);
        if (sourceImageNodeId && suppliedImageNodeId && sourceImageNodeId !== suppliedImageNodeId) {
            throw new Error(`ProductionSpec 分镜 ${rowId} 的 imageNodeId 与当前画布 Script 不一致`);
        }

        return {
            ...row,
            ...(sourceVideoNodeId && !suppliedVideoNodeId ? { videoNodeId: sourceVideoNodeId } : {}),
            ...(sourceImageNodeId && !suppliedImageNodeId ? { imageNodeId: sourceImageNodeId } : {}),
            ...(segmentBindings.length ? { segmentBindings } : {}),
            ...(segments ? { segments } : {}),
        };
    });

    return { ...input, plan: { ...plan, productionSpec: { ...productionSpec, storyboardRows } } };
}

export function filmBindingResolutionHint(input: RecordValue, canvasState: CanvasSnapshot | null) {
    const plan = asRecord(input.plan);
    const productionSpec = asRecord(plan?.productionSpec);
    if (!productionSpec || !Array.isArray(productionSpec.storyboardRows)) return "";
    if (Array.isArray(productionSpec.videoModels) && productionSpec.videoModels.length > 0) return "";
    const scriptRows = (canvasState?.nodes || [])
        .filter((node) => node.type === "script")
        .flatMap((node) => {
            const storyboard = asRecord(node.metadata?.storyboard);
            return Array.isArray(storyboard?.rows) ? storyboard.rows.map(asRecord).filter((row): row is RecordValue => Boolean(row)) : [];
        });
    const requested = productionSpec.storyboardRows.flatMap((rawRow) => {
        const row = asRecord(rawRow);
        if (!row) return [];
        const rowId = stringValue(row.rowId || row.id) || "<missing-rowId>";
        const segments = Array.isArray(row.segments) ? row.segments : [];
        const unboundSegments = segments.flatMap((rawSegment) => {
            const segment = asRecord(rawSegment);
            if (!segment || asRecord(segment.existingMedia)) return [];
            return [stringValue(segment.segmentId) || "<missing-segmentId>"];
        });
        if (!unboundSegments.length && !segments.length) return [{ rowId, segments: ["<plan-needs-generation>"] }];
        return unboundSegments.length ? [{ rowId, segments: unboundSegments }] : [];
    });
    if (!requested.length) return "";
    const available = scriptRows.map((row) => ({
        rowId: stringValue(row.id) || "<missing-rowId>",
        segmentBindings: (Array.isArray(row.segmentBindings) ? row.segmentBindings : []).flatMap((rawBinding) => {
            const binding = asRecord(rawBinding);
            return binding ? [`${stringValue(binding.segmentId) || "<missing-segmentId>"}:${stringValue(binding.status) || "unknown"}`] : [];
        }),
    }));
    return `；MCP 当前画布匹配诊断：requested=${JSON.stringify(requested)}，ScriptRows=${JSON.stringify(available.slice(0, 8))}`;
}

function normalizeBinding(binding: RecordValue) {
    return {
        segmentId: stringValue(binding.segmentId),
        order: binding.order,
        videoNodeId: stringValue(binding.videoNodeId),
        taskId: stringValue(binding.taskId),
        resourceId: stringValue(binding.resourceId),
        model: stringValue(binding.model),
        capabilityRevision: stringValue(binding.capabilityRevision),
        requestedDurationSeconds: binding.requestedDurationSeconds,
        timelineStartMs: binding.timelineStartMs,
        timelineDurationMs: binding.timelineDurationMs,
        status: stringValue(binding.status),
    };
}

function assertBindingMatches(rowId: string, segmentId: string, supplied: RecordValue, source: RecordValue) {
    for (const key of ["videoNodeId", "taskId", "resourceId"] as const) {
        const requested = stringValue(supplied[key]);
        const actual = stringValue(source[key]);
        if (requested && actual && requested !== actual) {
            throw new Error(`ProductionSpec 分镜 ${rowId} 片段 ${segmentId} 的追踪字段与当前画布 SegmentBinding 不一致`);
        }
    }
}

function isReusable(binding: RecordValue | undefined) {
    return Boolean(binding)
        && stringValue(binding?.status) === "succeeded"
        && Boolean(stringValue(binding?.videoNodeId))
        && Boolean(stringValue(binding?.resourceId));
}

function asRecord(value: unknown): RecordValue | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
