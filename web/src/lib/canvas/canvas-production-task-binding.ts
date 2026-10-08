import type { CanvasNodeData } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";

type ProductionRunBinding = {
    id: string;
    canvasId?: string;
    domainProjectId?: string;
    plan?: Record<string, unknown>;
    steps?: Array<{ id: string; stepKey?: string; kind?: string; storyboardRowId?: string }>;
};

type ProductionStepBinding = {
    id?: string;
    kind?: string;
    stepKey?: string;
    storyboardRowId?: string;
    segmentId?: string;
};

type ProductionTaskInput = {
    projectId?: string;
    type?: string;
    input?: Record<string, unknown>;
};

type ProductionTaskBindingInput = {
    task: GenerationTask;
    canvasId: string;
    domainProjectId?: string;
    nodeId: string;
    nodeType?: string;
    userId?: string;
    canvasNodes: CanvasNodeData[];
    getProductionRun: (runId: string) => Promise<ProductionRunBinding>;
    getProjectCanvasLinks?: (projectId: string) => Promise<Array<{ projectId: string; canvasId: string }>>;
};

/**
 * Verify a task's canvas ownership. Ordinary tasks keep the direct projectId check;
 * ProductionRun tasks are authorized by the current user's run and its persisted
 * canvas/storyboard provenance, because task.projectId may be the domain project ID.
 */
export async function generationTaskBelongsToCanvas(input: ProductionTaskBindingInput) {
    const { task, canvasId } = input;
    if (!task.productionRunId) return !task.projectId || task.projectId === canvasId;
    if (task.type === "canvas_video" && input.nodeType !== "video") return false;
    if (!input.userId || !task.userId || task.userId !== input.userId) return false;

    let run: ProductionRunBinding;
    try {
        run = await input.getProductionRun(task.productionRunId);
    } catch {
        return false;
    }
    if (run.id !== task.productionRunId || run.canvasId !== canvasId) return false;
    if (run.domainProjectId && run.domainProjectId !== input.domainProjectId) {
        // A server-created project link can precede the local canvas cache binding.
        // Verify the authoritative link; never accept a conflicting local project.
        if (input.domainProjectId || !input.getProjectCanvasLinks) return false;
        try {
            const links = await input.getProjectCanvasLinks(run.domainProjectId);
            if (!links.some((link) => link.projectId === run.domainProjectId && link.canvasId === canvasId)) return false;
        } catch {
            return false;
        }
    }
    if (task.projectId && task.projectId !== run.canvasId && task.projectId !== run.domainProjectId) return false;

    const metadata = taskInputMetadata(task.inputJson);
    if (metadata.canvasId && metadata.canvasId !== run.canvasId) return false;
    if (metadata.productionRunId && metadata.productionRunId !== run.id) return false;

    const metadataRow = record(metadata.storyboard);
    const metadataSegment = record(metadata.segment);
    const metadataRowId = text(metadata.storyboardRowId) || text(metadataRow?.rowId) || text(metadataRow?.id);
    const metadataSegmentId = text(metadata.segmentId) || text(metadataSegment?.segmentId) || text(metadataRow?.segmentId);
    const rowId = task.storyboardRowId || metadataRowId;
    const segmentId = task.segmentId || metadataSegmentId;
    if (task.storyboardRowId && metadataRowId && task.storyboardRowId !== metadataRowId) return false;
    if (task.segmentId && metadataSegmentId && task.segmentId !== metadataSegmentId) return false;
    if (segmentId && !rowId) return false;

    const runStep = run.steps?.find((step) => step.id === task.productionStepId);
    const firstFrameStep = isFirstFrameStep(runStep, rowId);
    if (task.type === "canvas_image" && rowId && !firstFrameStep
        && !(runStep?.kind === "image" && text(runStep.stepKey).startsWith("asset:"))) return false;
    if (firstFrameStep && (runStep?.storyboardRowId !== rowId || !rowId)) return false;

    const runRows = productionStoryboardRows(run.plan);
    let runRow: Record<string, unknown> | undefined;
    if (rowId) {
        const matches = runRows.filter((row) => text(row.rowId) === rowId || text(row.id) === rowId);
        if (matches.length > 1) return false;
        runRow = matches[0];
        if (!runRow && !productionRunHasStoryboardRow(run.plan, rowId)) return false;
        if (segmentId && runRow) {
            const segments = Array.isArray(runRow.segments) ? runRow.segments.map(record).filter(isRecord) : [];
            if (!segments.some((segment) => text(segment.segmentId) === segmentId)
                && !productionRunHasStoryboardSegment(run.plan, rowId, segmentId)) return false;
        }
        if (segmentId && !runRow && !productionRunHasStoryboardSegment(run.plan, rowId, segmentId)) return false;
    }

    const liveRows = input.canvasNodes
        .filter((node) => node.type === "script")
        .flatMap((node) => {
            const storyboard = record(node.metadata?.storyboard);
            return Array.isArray(storyboard?.rows) ? storyboard.rows.map(record).filter(isRecord) : [];
        });
    let liveRow: Record<string, unknown> | undefined;
    if (rowId) {
        const matches = liveRows.filter((row) => text(row.id) === rowId || text(row.rowId) === rowId);
        if (matches.length > 1) return false;
        liveRow = matches[0];
        if (liveRow && segmentId) {
            const bindings = Array.isArray(liveRow.segmentBindings) ? liveRow.segmentBindings.map(record).filter(isRecord) : [];
            const binding = bindings.find((item) => text(item.segmentId) === segmentId);
            if (binding?.taskId && binding.taskId !== task.id) return false;
            if (binding?.videoNodeId && binding.videoNodeId !== input.nodeId) return false;
        }
    }

    const metadataNodeId = text(metadata.nodeId);
    const contextNodeId = text(task.clientContext?.nodeId);
    if ((metadataNodeId && metadataNodeId !== input.nodeId) || (contextNodeId && contextNodeId !== input.nodeId)) return false;
    const runNodeId = productionTargetNodeId(runRow, segmentId, firstFrameStep);
    const liveNodeId = productionTargetNodeId(liveRow, segmentId, firstFrameStep);
    if (firstFrameStep) {
        if (task.type !== "canvas_image" || input.nodeType !== "image") return false;
        if (!runRow || !liveRow || !runNodeId || !liveNodeId || runNodeId !== liveNodeId) return false;
        const targetNodeId = runNodeId;
        if (!targetNodeId || targetNodeId !== input.nodeId) return false;
        if (canvasNodesNodeType(input.canvasNodes, targetNodeId) !== "image") return false;
        return true;
    }
    if ((runNodeId && runNodeId !== input.nodeId) || (liveNodeId && liveNodeId !== input.nodeId)) return false;

    // Require a traceable target node. A sourceNodeId alone may refer to an input asset,
    // so it only anchors the result when it is the target node itself.
    const assetStep = run.steps?.find((step) => step.id === task.productionStepId && step.kind === "image");
    const assetTargets = Array.isArray(run.plan?.assetTargets) ? run.plan.assetTargets.map(record).filter(isRecord) : [];
    const assetTargetMatches = assetStep && assetTargets.some((target) => text(target.nodeId) === input.nodeId
        && assetStep.stepKey === `asset:${text(target.assetId)}`);
    return Boolean(assetTargetMatches)
        || metadataNodeId === input.nodeId
        || contextNodeId === input.nodeId
        || runNodeId === input.nodeId
        || liveNodeId === input.nodeId
        || text(metadata.sourceNodeId) === input.nodeId;
}

/** Stamp server-visible run/canvas/storyboard provenance onto formal task input. */
export function bindProductionTaskCanvasContext<T extends ProductionTaskInput>(task: T, run: ProductionRunBinding, step: ProductionStepBinding, canvasNodes: CanvasNodeData[] = []): T {
    if (!run.canvasId) return task;
    const taskInput = { ...(task.input || {}) };
    const metadata = { ...(record(taskInput.metadata) || {}) };
    assertSameOrMissing(metadata.canvasId, run.canvasId, "任务 metadata.canvasId 与 ProductionRun 画布不一致");
    assertSameOrMissing(metadata.productionRunId, run.id, "任务 metadata.productionRunId 与当前 ProductionRun 不一致");

    const stepRowId = text(step.storyboardRowId);
    const stepSegmentId = text(step.segmentId);
    const metadataRow = record(metadata.storyboard);
    const metadataSegment = record(metadata.segment);
    const metadataRowId = text(metadata.storyboardRowId) || text(metadataRow?.rowId) || text(metadataRow?.id);
    const metadataSegmentId = text(metadata.segmentId) || text(metadataSegment?.segmentId) || text(metadataRow?.segmentId);
    assertSameOrMissing(metadataRowId, stepRowId, "任务 storyboardRowId 与当前 ProductionRun 步骤不一致");
    assertSameOrMissing(metadataSegmentId, stepSegmentId, "任务 segmentId 与当前 ProductionRun 步骤不一致");

    const runRows = productionStoryboardRows(run.plan);
    const matchingRunRows = stepRowId ? runRows.filter((row) => text(row.rowId) === stepRowId || text(row.id) === stepRowId) : [];
    if (matchingRunRows.length > 1) throw new Error(`ProductionRun 分镜 ${stepRowId} 有多个来源，拒绝提交任务`);
    const runRow = matchingRunRows[0];
    const firstFrameStep = isFirstFrameStep(step, stepRowId);
    if (step.kind === "image" && step.stepKey?.startsWith("first-frame:") && !firstFrameStep) {
        throw new Error(`ProductionRun 首帧步骤 ${step.stepKey} 与分镜行 ID 不一致`);
    }
    if (firstFrameStep) {
        const persistedStep = run.steps?.find((item) => item.id === step.id);
        if (!step.id || !persistedStep || persistedStep.kind !== "image" || persistedStep.stepKey !== step.stepKey || persistedStep.storyboardRowId !== stepRowId) {
            throw new Error(`ProductionRun 首帧步骤 ${step.stepKey} 与已保存步骤不一致`);
        }
        if (!runRow) throw new Error(`ProductionRun 分镜 ${stepRowId} 不存在，不能绑定首帧`);
    }
    if (stepSegmentId && runRow) {
        const segments = Array.isArray(runRow.segments) ? runRow.segments.map(record).filter(isRecord) : [];
        if (!segments.some((segment) => text(segment.segmentId) === stepSegmentId)) {
            throw new Error(`ProductionRun 分镜 ${stepRowId} 不包含片段 ${stepSegmentId}`);
        }
    }

    const liveRows = canvasNodes
        .filter((node) => node.type === "script")
        .flatMap((node) => {
            const storyboard = record(node.metadata?.storyboard);
            return Array.isArray(storyboard?.rows) ? storyboard.rows.map(record).filter(isRecord) : [];
        });
    const matchingLiveRows = stepRowId ? liveRows.filter((row) => text(row.id) === stepRowId || text(row.rowId) === stepRowId) : [];
    if (matchingLiveRows.length > 1) throw new Error(`当前画布分镜 ${stepRowId} 有多个 Script 来源，拒绝提交任务`);
    const liveRow = matchingLiveRows[0];
    const plannedNodeId = productionTargetNodeId(runRow, stepSegmentId, firstFrameStep);
    const liveNodeId = productionTargetNodeId(liveRow, stepSegmentId, firstFrameStep);
    const requestedNodeId = text(metadata.nodeId);
    if (plannedNodeId && liveNodeId && plannedNodeId !== liveNodeId) throw new Error(`ProductionRun 分镜 ${stepRowId} 的目标节点与当前画布不一致`);
    const rowNodeId = plannedNodeId || liveNodeId;
    if (firstFrameStep && (!plannedNodeId || !liveNodeId)) throw new Error(`ProductionRun 分镜 ${stepRowId} 缺少已绑定的首帧 imageNodeId`);
    assertSameOrMissing(requestedNodeId, rowNodeId, "任务 metadata.nodeId 与分镜目标节点不一致");

    const assetTargets = Array.isArray(run.plan?.assetTargets) ? run.plan.assetTargets.map(record).filter(isRecord) : [];
    const assetTarget = step.kind === "image" ? assetTargets.find((target) => step.stepKey === `asset:${text(target.assetId)}`) : undefined;
    const assetNodeId = text(assetTarget?.nodeId);
    assertSameOrMissing(requestedNodeId, assetNodeId, "任务 metadata.nodeId 与资产目标节点不一致");
    let nodeId = requestedNodeId || assetNodeId || (step.kind === "video" || firstFrameStep ? rowNodeId : "");
    if (firstFrameStep && !nodeId) throw new Error(`ProductionRun 分镜 ${stepRowId} 缺少首帧 imageNodeId`);
    if (!nodeId && step.kind === "video") {
        const sourceNodeId = text(metadata.sourceNodeId);
        const sourceVideoNode = canvasNodes.find((node) => node.id === sourceNodeId && node.type === "video");
        if (sourceVideoNode) nodeId = sourceNodeId;
    }
    if (nodeId && canvasNodes.length && !canvasNodes.some((node) => node.id === nodeId)) {
        throw new Error(`ProductionRun 分镜 ${stepRowId || "(无分镜)"} 的目标节点不在当前画布`);
    }
    const expectedNodeType = firstFrameStep ? "image" : step.kind === "video" ? "video" : undefined;
    if (expectedNodeType && nodeId && canvasNodes.length && canvasNodes.find((node) => node.id === nodeId)?.type !== expectedNodeType) {
        throw new Error(`ProductionRun 分镜 ${stepRowId || "(无分镜)"} 的目标节点不是${expectedNodeType === "image" ? "图片" : "视频"}节点`);
    }
    const sourceNodeId = text(metadata.sourceNodeId);
    if (sourceNodeId && canvasNodes.length && !canvasNodes.some((node) => node.id === sourceNodeId)) {
        throw new Error(`任务 sourceNodeId ${sourceNodeId} 不在当前画布`);
    }

    taskInput.metadata = {
        ...metadata,
        canvasId: run.canvasId,
        productionRunId: run.id,
        ...(stepRowId ? { storyboardRowId: stepRowId } : {}),
        ...(stepSegmentId ? { segmentId: stepSegmentId } : {}),
        ...(nodeId ? { nodeId } : {}),
    };
    return { ...task, input: taskInput };
}

function productionStoryboardRows(plan: Record<string, unknown> | undefined) {
    const productionSpec = record(plan?.productionSpec);
    return Array.isArray(productionSpec?.storyboardRows) ? productionSpec.storyboardRows.map(record).filter(isRecord) : [];
}

function productionTargetNodeId(row: Record<string, unknown> | undefined, segmentId: string, firstFrameStep: boolean) {
    if (firstFrameStep) return text(row?.imageNodeId);
    // A row can own a main shot and separate transition clips. Their declared
    // segment bindings, rather than the row's primary video, anchor each result.
    const bindings = Array.isArray(row?.segmentBindings) ? row.segmentBindings.map(record).filter(isRecord) : [];
    const matches = segmentId ? bindings.filter((binding) => text(binding.segmentId) === segmentId) : [];
    if (matches.length > 1) throw new Error(`分镜片段 ${segmentId} 有多个目标节点，拒绝绑定`);
    return text(matches[0]?.videoNodeId) || text(row?.videoNodeId);
}

function isFirstFrameStep(step: { kind?: string; stepKey?: string; storyboardRowId?: string } | undefined, rowId: string) {
    if (!step || step.kind !== "image" || !rowId || text(step.storyboardRowId) !== rowId) return false;
    return text(step.stepKey) === `first-frame:${safeProductionKey(rowId)}`;
}

function safeProductionKey(value: string) {
    return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function canvasNodesNodeType(nodes: CanvasNodeData[], nodeId: string) {
    return nodes.find((node) => node.id === nodeId)?.type;
}

function productionRunHasStoryboardRow(plan: Record<string, unknown> | undefined, rowId: string) {
    const manifest = record(plan?.executionManifest);
    return [manifest?.rowAssetBindings, manifest?.selectedModelsBySegment, manifest?.timelineSpans]
        .some((value) => Array.isArray(value) && value.some((raw) => {
            const row = record(raw);
            return row && text(row.storyboardRowId) === rowId;
        }));
}

function productionRunHasStoryboardSegment(plan: Record<string, unknown> | undefined, rowId: string, segmentId: string) {
    const manifest = record(plan?.executionManifest);
    const selected = Array.isArray(manifest?.selectedModelsBySegment) ? manifest.selectedModelsBySegment : [];
    if (selected.some((raw) => {
        const item = record(raw);
        return item && text(item.storyboardRowId) === rowId && text(item.segmentId) === segmentId;
    })) return true;
    const spans = Array.isArray(manifest?.timelineSpans) ? manifest.timelineSpans : [];
    if (spans.some((raw) => {
        const item = record(raw);
        return item && text(item.storyboardRowId) === rowId && text(item.segmentId) === segmentId;
    })) return true;
    const bindings = Array.isArray(manifest?.rowAssetBindings) ? manifest.rowAssetBindings : [];
    return bindings.some((raw) => {
        const item = record(raw);
        const ids = Array.isArray(item?.segmentIds) ? item.segmentIds : [];
        return item && text(item.storyboardRowId) === rowId && ids.some((value) => text(value) === segmentId);
    });
}

function taskInputMetadata(raw: string | undefined) {
    if (!raw) return {};
    try {
        const input = record(JSON.parse(raw));
        return record(input?.metadata) || {};
    } catch {
        return {};
    }
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isRecord(value: Record<string, unknown> | null): value is Record<string, unknown> {
    return value !== null;
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function assertSameOrMissing(supplied: unknown, expected: string, message: string) {
    const value = text(supplied);
    if (value && expected && value !== expected) throw new Error(message);
}
