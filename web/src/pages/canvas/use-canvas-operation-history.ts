import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { applyCanvasOperations, hashCanvasSnapshot, summarizeCanvasOperations, type CanvasApplyOpsSnapshot, type CanvasGenerationOperationTask, type CanvasOperation, type CanvasSnapshot } from "@/lib/canvas/canvas-operation-contract";
import { buildCanvasNodeMentionReferenceMap, normalizeCanvasNodeMentionTokens } from "@/lib/canvas/canvas-resource-references";
import { createGenerationRetryContext, generationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { waitForCanvasGenerationSubmission } from "@/lib/canvas/canvas-agent-generation-wait";
import { subscribeGenerationTasks, type GenerationTask } from "@/services/api/task-center";
import { persistCanvasOperationContinuationEffect } from "@/services/canvas-generation-consumer";
import { consumeGenerationTaskAgent } from "@/services/project-asset-sync";
import type { CanvasConnection, CanvasNodeData, ContextMenuState, ViewportTransform } from "@/types/canvas";

import type { CanvasNodeGenerationOptions } from "./use-canvas-generation-executor";

export type CanvasGenerationContext = { conversationId?: string; messageId?: string; source?: "online" | "local" };
type CanvasGenerationContinuation = NonNullable<NonNullable<CanvasNodeData["metadata"]>["agentGenerationContinuation"]>;
type CanvasGenerationOptions = Pick<CanvasNodeGenerationOptions, "context" | "retryContext" | "clientOperationId" | "onTaskUpdate" | "skipDuplicateConfirmation">;
type CanvasGenerationContinuationDependencies = {
    consumeAgent?: typeof consumeGenerationTaskAgent;
    persistContinuation?: typeof persistCanvasOperationContinuationEffect;
    projectId?: string;
    nodeId?: string;
    previousNodes?: CanvasNodeData[];
    nodesRef?: { current: CanvasNodeData[] };
    setNodes?: Dispatch<SetStateAction<CanvasNodeData[]>>;
};

type UseCanvasOperationHistoryOptions = {
    projectId: string;
    domainProjectId?: string;
    projectTitle: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: Set<string>;
    viewport: ViewportTransform;
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    selectedNodeIdsRef: { current: Set<string> };
    viewportRef: { current: ViewportTransform };
    generateNodeRef: { current: ((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, options?: CanvasGenerationOptions) => Promise<void>) | null };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setViewport: Dispatch<SetStateAction<ViewportTransform>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
    focusSelection: () => boolean;
};

export type CanvasOperationChange = {
    id: string;
    summary: string;
    nodeIds: string[];
    undoCount: number;
};

export type CanvasAgentOperationTrackedFields = { viewport: boolean; selection: boolean };
export type CanvasOperationUndoBatch = { snapshot: CanvasSnapshot; afterSnapshot: CanvasSnapshot; afterStateHash: string; trackedFields?: CanvasAgentOperationTrackedFields; change: Omit<CanvasOperationChange, "undoCount"> };
export type CanvasOperationRedoBatch = { snapshot: CanvasSnapshot; expectedStateHash: string; trackedFields?: CanvasAgentOperationTrackedFields; change: Omit<CanvasOperationChange, "undoCount"> };
export type CanvasAgentOperationHistory = {
    undoable: Array<Omit<CanvasOperationChange, "undoCount">>;
    redoable: Array<Omit<CanvasOperationChange, "undoCount">>;
};
export type RecordCanvasAgentOperation = (before: CanvasSnapshot, after: CanvasSnapshot, summary: string, nodeIds: string[]) => void;

export function createCanvasAgentOperationBatch(before: CanvasSnapshot, after: CanvasSnapshot, summary: string, nodeIds: string[]): CanvasOperationUndoBatch | null {
    if (!before || !after || before.projectId !== after.projectId) return null;
    const trackedFields = { viewport: true, selection: true };
    const afterStateHash = hashCanvasAgentOperationSnapshot(after, trackedFields);
    if (hashCanvasAgentOperationSnapshot(before, trackedFields) === afterStateHash) return null;
    return {
        snapshot: before,
        afterSnapshot: after,
        afterStateHash,
        trackedFields,
        change: { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, summary, nodeIds: [...new Set(nodeIds)] },
    };
}

/**
 * Connection sync rewrites the internal @[node:id] spelling to the matching
 * visible @label. Treat only that provable serialization change as equivalent
 * while keeping all other node content in the history hash.
 */
export function hashCanvasAgentOperationSnapshot(snapshot: CanvasSnapshot, trackedFields: CanvasAgentOperationTrackedFields = { viewport: true, selection: true }) {
    const references = buildCanvasNodeMentionReferenceMap(snapshot.nodes, snapshot.connections);
    let changed = false;
    const nodes = snapshot.nodes.map((node) => {
        const composerContent = node.metadata?.composerContent;
        if (typeof composerContent !== "string" || !composerContent.includes("@[node:")) return node;
        const normalized = normalizeCanvasNodeMentionTokens(composerContent, references.get(node.id) || []);
        if (normalized === composerContent) return node;
        changed = true;
        return { ...node, metadata: { ...node.metadata, composerContent: normalized } };
    });
    return hashCanvasSnapshot({
        ...(changed ? { ...snapshot, nodes } : snapshot),
        ...(trackedFields.viewport ? {} : { viewport: { x: 0, y: 0, k: 1 } }),
        ...(trackedFields.selection ? {} : { selectedNodeIds: [] }),
    });
}

export function canvasAgentOperationTrackedFields(ops: CanvasOperation[], addedNodeIds: ReadonlySet<string>): CanvasAgentOperationTrackedFields {
    const selectionOps = ops.filter((op): op is Extract<CanvasOperation, { type: "select_nodes" }> => op.type === "select_nodes");
    return {
        viewport: ops.some((op) => op.type === "set_viewport"),
        // Creating a generation/workflow flow includes a selection of its new
        // node for automatic focus. A standalone selection remains an Agent
        // operation and is still tracked and undoable.
        selection: selectionOps.some((op) => op.ids.length === 0 || op.ids.some((id) => !addedNodeIds.has(id))),
    };
}

function keepUntrackedViewState(target: CanvasSnapshot, current: CanvasSnapshot, trackedFields: CanvasAgentOperationTrackedFields = { viewport: true, selection: true }) {
    if (trackedFields.viewport && trackedFields.selection) return target;
    return {
        ...target,
        ...(trackedFields.viewport ? {} : { viewport: current.viewport }),
        ...(trackedFields.selection ? {} : { selectedNodeIds: current.selectedNodeIds.filter((id) => target.nodes.some((node) => node.id === id)) }),
    };
}

export function undoCanvasAgentOperationHistory(undoStack: CanvasOperationUndoBatch[], redoStack: CanvasOperationRedoBatch[], current: CanvasSnapshot) {
    const batch = undoStack.at(-1);
    if (!batch) return { status: "empty" as const, undoStack, redoStack };
    const trackedFields = batch.trackedFields || { viewport: true, selection: true };
    if (batch.afterStateHash !== hashCanvasAgentOperationSnapshot(current, trackedFields)) return { status: "stale" as const, undoStack: [], redoStack: [] };
    return {
        status: "applied" as const,
        snapshot: keepUntrackedViewState(batch.snapshot, current, trackedFields),
        trackedFields,
        change: batch.change,
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, { snapshot: batch.afterSnapshot, expectedStateHash: hashCanvasAgentOperationSnapshot(batch.snapshot, trackedFields), trackedFields, change: batch.change }].slice(-10),
    };
}

export function redoCanvasAgentOperationHistory(undoStack: CanvasOperationUndoBatch[], redoStack: CanvasOperationRedoBatch[], current: CanvasSnapshot) {
    const batch = redoStack.at(-1);
    if (!batch) return { status: "empty" as const, undoStack, redoStack };
    const trackedFields = batch.trackedFields || { viewport: true, selection: true };
    if (batch.expectedStateHash !== hashCanvasAgentOperationSnapshot(current, trackedFields)) return { status: "stale" as const, undoStack: [], redoStack: [] };
    return {
        status: "applied" as const,
        snapshot: keepUntrackedViewState(batch.snapshot, current, trackedFields),
        trackedFields,
        change: batch.change,
        undoStack: [...undoStack, { snapshot: current, afterSnapshot: keepUntrackedViewState(batch.snapshot, current, trackedFields), afterStateHash: hashCanvasAgentOperationSnapshot(batch.snapshot, trackedFields), trackedFields, change: batch.change }].slice(-10),
        redoStack: redoStack.slice(0, -1),
    };
}
type RunCanvasGenerationOpsInput = {
    generationOps: Array<Extract<CanvasOperation, { type: "run_generation" }>>;
    nodes: CanvasNodeData[];
    context?: CanvasGenerationContext;
    generate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, options: CanvasGenerationOptions) => Promise<void>;
    subscribeTasks?: (ids: readonly string[], listener: (task: GenerationTask) => void) => () => void;
    consumeTask?: typeof consumeGenerationTaskAgent;
    resumeAgent?: (task: GenerationTask) => Promise<void>;
    onContinuation?: (nodeId: string, continuation: CanvasGenerationContinuation) => Promise<void> | void;
};

export async function runCanvasGenerationOps({
    generationOps,
    nodes,
    context,
    generate,
    subscribeTasks = subscribeGenerationTasks,
    consumeTask = consumeGenerationTaskAgent,
    resumeAgent = async () => undefined,
    onContinuation,
}: RunCanvasGenerationOpsInput): Promise<Array<{ operationNodeId: string; task: GenerationTask }>> {
    const observations = new Map<string, Promise<void>>();
    const operationTasks = new Map<string, GenerationTask>();
    const observe = (taskId: string, nodeId: string, continuationIdPromise?: Promise<string>) => {
        const existing = observations.get(taskId);
        if (existing) return existing;
        const observation = new Promise<void>((resolve, reject) => {
            let unsubscribe: (() => void) | undefined;
            let settled = false;
            unsubscribe = subscribeTasks([taskId], (task) => {
                if (settled || (task.status !== "succeeded" && task.status !== "failed" && task.status !== "cancelled")) return;
                settled = true;
                queueMicrotask(() => {
                    void (async () => {
                        const taskContext = {
                            conversationId: task.clientContext?.conversationId || context?.conversationId,
                            messageId: task.clientContext?.messageId || context?.messageId,
                        };
                        const continuationId = await (continuationIdPromise ?? canvasGenerationContinuationId(task.clientContext?.nodeId || nodeId, taskContext));
                        const continuation: CanvasGenerationContinuation = {
                            id: continuationId,
                            taskId: task.id,
                            ...(taskContext.conversationId ? { conversationId: taskContext.conversationId } : {}),
                            ...(taskContext.messageId ? { messageId: taskContext.messageId } : {}),
                            ...(context?.source ? { source: context.source } : {}),
                            status: task.status === "succeeded" ? "pending" : "failed",
                        };
                        if (task.status !== "succeeded") {
                            await onContinuation?.(nodeId, continuation);
                            await resumeAgent(task);
                            return;
                        }
                        await consumeTask(task, continuationId, async (effect?: { effectKey?: string }) => {
                            await onContinuation?.(nodeId, {
                                ...continuation,
                                status: "completed",
                                ...(effect?.effectKey ? { effectKey: effect.effectKey } : {}),
                            });
                            await resumeAgent(task);
                        });
                    })()
                        .then(resolve, reject)
                        .finally(() => unsubscribe?.());
                });
            });
        });
        observations.set(taskId, observation);
        return observation;
    };

    if (!generationOps.length) {
        const taskNodes = nodes.filter((node) => node.metadata?.agentGenerationContinuation?.status === "pending" && (node.metadata?.taskId || node.metadata.agentGenerationContinuation.taskId));
        await Promise.all(
            taskNodes.map((node) => {
                const continuation = node.metadata!.agentGenerationContinuation!;
                return observe(node.metadata?.taskId || continuation.taskId, node.id, Promise.resolve(continuation.id));
            }),
        );
        return [];
    }

    await Promise.all(
        generationOps.map(async (op) => {
            const target = nodes.find((node) => node.id === op.nodeId);
            const prompt = op.prompt?.trim() ? op.prompt : (target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
            const retryOf = op.retry ? target?.metadata?.taskId : undefined;
            if (op.retry && !retryOf) throw new Error("当前节点没有可重试的生成任务");
            const retryContext = retryOf ? await createGenerationRetryContext(retryOf, target?.metadata?.attemptGroupId) : undefined;
            const continuationIdPromise = canvasGenerationContinuationId(op.nodeId, context);
            let observation: Promise<void> | undefined;
            let continuationTaskId = "";
            let resolveSubmitted!: (task: GenerationTask) => void;
            const submitted = new Promise<GenerationTask>((resolve) => {
                resolveSubmitted = resolve;
            });
            const generationPromise = generate(op.nodeId, op.mode || target?.metadata?.generationMode || "image", prompt, {
                // source 透传下去：本地/MCP 驱动时配置缺失必须报错，不能静默不提交。
                context: context ? { conversationId: context.conversationId, messageId: context.messageId, source: context.source } : undefined,
                skipDuplicateConfirmation: true,
                ...(retryContext ? { retryContext } : op.clientOperationId ? { clientOperationId: op.clientOperationId } : {}),
                onTaskUpdate: (task) => {
                    operationTasks.set(op.nodeId, task);
                    if (continuationTaskId) return;
                    continuationTaskId = task.id;
                    observation = observe(task.id, op.nodeId, continuationIdPromise);
                    resolveSubmitted(task);
                    void continuationIdPromise.then((continuationId) => {
                        onContinuation?.(op.nodeId, {
                            id: continuationId,
                            taskId: task.id,
                            ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
                            ...(context?.messageId ? { messageId: context.messageId } : {}),
                            ...(context?.source ? { source: context.source } : {}),
                            status: "pending",
                        });
                    });
                },
            });
            if (context?.source === "local") {
                const result = await waitForCanvasGenerationSubmission(generationPromise, submitted);
                if (result.kind === "submitted") {
                    // The browser task consumer continues in the background; MCP only waits for durable task acceptance.
                    void generationPromise.catch((error) => console.error("[yingce-local-agent] 生成任务后台处理失败", error));
                    void observation?.catch((error) => console.error("[yingce-local-agent] 生成任务后续处理失败", error));
                    return;
                }
                if (!continuationTaskId) throw new Error("生成流程结束，但没有创建可追踪的任务");
            } else {
                await generationPromise;
            }
            if (observation) await observation;
        }),
    );
    return [...operationTasks].map(([operationNodeId, task]) => ({ operationNodeId, task }));
}

export async function consumeCanvasGenerationContinuation(
    task: GenerationTask,
    continuation: CanvasGenerationContinuation,
    onCompleted: (continuation: CanvasGenerationContinuation, signal?: AbortSignal) => Promise<void> | void,
    dependencies: CanvasGenerationContinuationDependencies = {},
    signal?: AbortSignal,
) {
    if (continuation.status !== "pending" || continuation.taskId !== task.id || task.status !== "succeeded") return task;
    const consumeAgent = dependencies.consumeAgent ?? consumeGenerationTaskAgent;
    return consumeAgent(
        task,
        continuation.id,
        async ({ effectKey, signal: leaseSignal }) => {
            const completed = { ...continuation, status: "completed" as const, effectKey };
            if (dependencies.projectId && dependencies.nodeId && dependencies.nodesRef && dependencies.setNodes) {
                await (dependencies.persistContinuation ?? persistCanvasOperationContinuationEffect)({
                    projectId: dependencies.projectId,
                    nodeId: dependencies.nodeId,
                    continuation: completed,
                    effectKey,
                    signal: leaseSignal,
                    previousNodes: dependencies.previousNodes,
                    nodesRef: dependencies.nodesRef,
                    setNodes: dependencies.setNodes,
                });
            }
            await onCompleted(completed, leaseSignal);
        },
        { signal },
    );
}

async function canvasGenerationContinuationId(nodeId: string, context?: CanvasGenerationContext) {
    const seed = new TextEncoder().encode(`canvas-operation-generation\0${context?.source || ""}\0${context?.conversationId || ""}\0${context?.messageId || ""}\0${nodeId}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", seed));
    return `agent:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function useCanvasOperationHistory({
    projectId,
    domainProjectId,
    projectTitle,
    nodes,
    connections,
    selectedNodeIds,
    viewport,
    nodesRef,
    connectionsRef,
    selectedNodeIdsRef,
    viewportRef,
    generateNodeRef,
    setNodes,
    setConnections,
    setSelectedNodeIds,
    setSelectedConnectionId,
    setViewport,
    setContextMenu,
    focusSelection,
}: UseCanvasOperationHistoryOptions) {
    const undoStackRef = useRef<CanvasOperationUndoBatch[]>([]);
    const redoStackRef = useRef<CanvasOperationRedoBatch[]>([]);
    const [undoOpsCount, setUndoOpsCount] = useState(0);
    const [redoOpsCount, setRedoOpsCount] = useState(0);
    const [lastAgentChange, setLastAgentChange] = useState<CanvasOperationChange | null>(null);
    const snapshot = useMemo<CanvasSnapshot>(
        () => ({ projectId, domainProjectId, title: projectTitle, nodes, connections, selectedNodeIds: Array.from(selectedNodeIds), viewport }),
        [connections, domainProjectId, nodes, projectId, projectTitle, selectedNodeIds, viewport],
    );

    useEffect(() => {
        undoStackRef.current = [];
        redoStackRef.current = [];
        setUndoOpsCount(0);
        setRedoOpsCount(0);
        setLastAgentChange(null);
    }, [projectId]);

    useEffect(() => {
        const undoTrackedFields = undoStackRef.current.at(-1)?.trackedFields || { viewport: true, selection: true };
        const redoTrackedFields = redoStackRef.current.at(-1)?.trackedFields || { viewport: true, selection: true };
        const undoCurrentHash = hashCanvasAgentOperationSnapshot(snapshot, undoTrackedFields);
        const redoCurrentHash = hashCanvasAgentOperationSnapshot(snapshot, redoTrackedFields);
        const undo = undoStackRef.current.at(-1);
        const redo = redoStackRef.current.at(-1);
        if ((!undo || undo.afterStateHash === undoCurrentHash) && (!redo || redo.expectedStateHash === redoCurrentHash)) return;
        // History is snapshot-bound. Any intervening edit invalidates both directions.
        undoStackRef.current = [];
        redoStackRef.current = [];
        setUndoOpsCount(0);
        setRedoOpsCount(0);
        setLastAgentChange(null);
    }, [snapshot]);

    const applyOps = useCallback(
        async (ops?: CanvasOperation[], generationContext?: CanvasGenerationContext): Promise<CanvasApplyOpsSnapshot> => {
            const safeOps = Array.isArray(ops) ? ops.filter((op) => op?.type) : [];
            const before = { projectId, domainProjectId, title: projectTitle, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: Array.from(selectedNodeIdsRef.current), viewport: viewportRef.current };
            const generationOps = safeOps.filter((op): op is Extract<CanvasOperation, { type: "run_generation" }> => op.type === "run_generation" && Boolean(op.nodeId));
            const next = applyCanvasOperations(
                before,
                safeOps.filter((op) => op.type !== "run_generation"),
            );
            const beforeNodeIds = new Set(before.nodes.map((node) => node.id));
            const addedNodeIds = next.nodes.filter((node) => !beforeNodeIds.has(node.id)).map((node) => node.id);
            const addedNodeIdSet = new Set(addedNodeIds);
            const focusNodeIds = next.nodes.filter((node) => addedNodeIdSet.has(node.id) && (!node.parentId || !addedNodeIdSet.has(node.parentId))).map((node) => node.id);
            const trackedFields = canvasAgentOperationTrackedFields(safeOps, addedNodeIdSet);
            const affectedNodeIds = focusNodeIds.length ? focusNodeIds : agentAffectedNodeIds(safeOps, next.nodes);
            const nextSelectedNodeIds = focusNodeIds.length && !trackedFields.selection ? focusNodeIds : next.selectedNodeIds;
            nodesRef.current = next.nodes;
            connectionsRef.current = next.connections;
            selectedNodeIdsRef.current = new Set(nextSelectedNodeIds);
            viewportRef.current = next.viewport;
            setNodes(next.nodes);
            setConnections(next.connections);
            setSelectedNodeIds(new Set(nextSelectedNodeIds));
            setSelectedConnectionId(null);
            setViewport(next.viewport);
            setContextMenu(null);
            const afterSnapshot: CanvasSnapshot = { ...next, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: [...nextSelectedNodeIds], projectId, domainProjectId, title: projectTitle };
            const beforeStateHash = hashCanvasAgentOperationSnapshot(before, trackedFields);
            const afterStateHash = hashCanvasAgentOperationSnapshot(afterSnapshot, trackedFields);
            if (safeOps.length && beforeStateHash !== afterStateHash) {
                const change = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, summary: summarizeCanvasOperations(safeOps) || "画布操作已完成", nodeIds: affectedNodeIds };
                redoStackRef.current = [];
                setRedoOpsCount(0);
                undoStackRef.current = [...undoStackRef.current, { snapshot: before, afterSnapshot, afterStateHash, trackedFields, change }].slice(-10);
                const nextUndoCount = undoStackRef.current.length;
                setUndoOpsCount(nextUndoCount);
                setLastAgentChange({ ...change, undoCount: nextUndoCount });
            }
            if (focusNodeIds.length && !trackedFields.viewport) queueMicrotask(() => focusSelection());
            let generationTasks: CanvasGenerationOperationTask[] = [];
            if (generationOps.length) {
                const generate = generateNodeRef.current;
                if (generate) {
                    const operationTasks = await runCanvasGenerationOps({
                        generationOps,
                        nodes: nodesRef.current,
                        generate,
                        context: generationContext,
                        onContinuation: async (nodeId, continuation) => {
                            if (continuation.status === "completed" && continuation.effectKey) {
                                await persistCanvasOperationContinuationEffect({
                                    projectId,
                                    nodeId,
                                    continuation,
                                    effectKey: continuation.effectKey,
                                    nodesRef,
                                    setNodes,
                                });
                                return;
                            }
                            setNodes((current) => {
                                const updated = current.map((node) =>
                                    node.id === nodeId
                                        ? {
                                              ...node,
                                              metadata: {
                                                  ...node.metadata,
                                                  agentGenerationContinuation: continuation,
                                              },
                                          }
                                        : node,
                                );
                                nodesRef.current = updated;
                                return updated;
                            });
                        },
                    });
                    if (operationTasks.length) {
                        const latestNodes = nodesRef.current;
                        const nodeById = new Map(latestNodes.map((node) => [node.id, node]));
                        const updates = new Map<string, GenerationTask>();
                        for (const item of operationTasks) {
                            const generatedNodeId = item.task.clientContext?.nodeId;
                            const bindingNodeId = generatedNodeId && nodeById.has(generatedNodeId) ? generatedNodeId : item.operationNodeId;
                            if (nodeById.has(bindingNodeId)) updates.set(bindingNodeId, item.task);
                            generationTasks.push({
                                operationNodeId: item.operationNodeId,
                                taskId: item.task.id,
                                status: item.task.status,
                                ...(item.task.stage ? { stage: item.task.stage } : {}),
                                ...(typeof item.task.progress === "number" ? { progress: item.task.progress } : {}),
                                ...(item.task.model ? { model: item.task.model } : {}),
                                ...(item.task.operation ? { operation: item.task.operation } : {}),
                            });
                        }
                        if (updates.size) {
                            const patchedNodes: CanvasNodeData[] = latestNodes.map((node): CanvasNodeData => {
                                const task = updates.get(node.id);
                                if (!task) return node;
                                const failed = task.status === "failed" || task.status === "cancelled";
                                const completedWithContent = task.status === "succeeded" && Boolean(node.metadata?.content);
                                const retainedSuccess = node.metadata?.status === "success" && Boolean(node.metadata?.content);
                                return {
                                    ...node,
                                    metadata: {
                                        ...node.metadata,
                                        ...generationTaskMetadata(task),
                                        status: failed ? "error" : completedWithContent || retainedSuccess ? "success" : "loading",
                                    },
                                };
                            });
                            nodesRef.current = patchedNodes;
                            setNodes(patchedNodes);
                        }
                    }
                }
            }
            return { ...next, nodes: nodesRef.current, connections: connectionsRef.current, projectId, title: projectTitle, selectedNodeIds: nextSelectedNodeIds, ...(generationTasks.length ? { generationTasks } : {}) };
        },
        [connectionsRef, domainProjectId, focusSelection, generateNodeRef, nodesRef, projectId, projectTitle, selectedNodeIdsRef, setConnections, setContextMenu, setNodes, setSelectedConnectionId, setSelectedNodeIds, setViewport, viewportRef],
    );

    const recordAgentOperation = useCallback((before: CanvasSnapshot, after: CanvasSnapshot, summary: string, nodeIds: string[]) => {
        if (after.projectId !== projectId) return;
        const batch = createCanvasAgentOperationBatch(before, after, summary, nodeIds);
        if (!batch) return;
        const { change } = batch;
        // Native UI handlers can already have recorded a nested metadata patch (for
        // example, createNode followed by title/size initialization). Coalesce it
        // into the single user-visible MCP operation.
        const affected = new Set(change.nodeIds);
        const previous = undoStackRef.current.at(-1);
        if (previous && previous.change.nodeIds.some((id) => affected.has(id))) undoStackRef.current = undoStackRef.current.slice(0, -1);
        redoStackRef.current = [];
        undoStackRef.current = [...undoStackRef.current, batch].slice(-10);
        setUndoOpsCount(undoStackRef.current.length);
        setRedoOpsCount(0);
        setLastAgentChange({ ...change, undoCount: undoStackRef.current.length });
    }, [projectId]);

    const undoOps = useCallback(() => {
        const current: CanvasSnapshot = { projectId, domainProjectId, title: projectTitle, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: [...selectedNodeIdsRef.current], viewport: viewportRef.current };
        const result = undoCanvasAgentOperationHistory(undoStackRef.current, redoStackRef.current, current);
        if (result.status !== "applied") {
            if (result.status === "stale") {
                undoStackRef.current = [];
                redoStackRef.current = [];
                setUndoOpsCount(0);
                setRedoOpsCount(0);
                setLastAgentChange(null);
            }
            return null;
        }
        undoStackRef.current = result.undoStack;
        redoStackRef.current = result.redoStack;
        const restored = result.snapshot;
        nodesRef.current = restored.nodes;
        connectionsRef.current = restored.connections;
        selectedNodeIdsRef.current = new Set(restored.selectedNodeIds);
        viewportRef.current = restored.viewport;
        setNodes(restored.nodes);
        setConnections(restored.connections);
        setSelectedNodeIds(new Set(restored.selectedNodeIds));
        setSelectedConnectionId(null);
        setViewport(restored.viewport);
        setContextMenu(null);
        const restoredSnapshot: CanvasSnapshot = { ...restored, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: [...selectedNodeIdsRef.current], viewport: viewportRef.current };
        redoStackRef.current = redoStackRef.current.map((entry, index) => index === redoStackRef.current.length - 1 ? { ...entry, expectedStateHash: hashCanvasAgentOperationSnapshot(restoredSnapshot, entry.trackedFields || { viewport: true, selection: true }) } : entry);
        setUndoOpsCount(undoStackRef.current.length);
        setRedoOpsCount(redoStackRef.current.length);
        setLastAgentChange(null);
        return restoredSnapshot;
    }, [connectionsRef, domainProjectId, nodesRef, projectId, projectTitle, selectedNodeIdsRef, setConnections, setContextMenu, setNodes, setSelectedConnectionId, setSelectedNodeIds, setViewport, viewportRef]);

    const redoOps = useCallback(() => {
        const current: CanvasSnapshot = { projectId, domainProjectId, title: projectTitle, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: [...selectedNodeIdsRef.current], viewport: viewportRef.current };
        const result = redoCanvasAgentOperationHistory(undoStackRef.current, redoStackRef.current, current);
        if (result.status !== "applied") {
            if (result.status === "stale") {
                undoStackRef.current = [];
                redoStackRef.current = [];
                setUndoOpsCount(0);
                setRedoOpsCount(0);
                setLastAgentChange(null);
            }
            return null;
        }
        undoStackRef.current = result.undoStack;
        redoStackRef.current = result.redoStack;
        const target = result.snapshot;
        nodesRef.current = target.nodes;
        connectionsRef.current = target.connections;
        selectedNodeIdsRef.current = new Set(target.selectedNodeIds);
        viewportRef.current = target.viewport;
        setNodes(target.nodes);
        setConnections(target.connections);
        setSelectedNodeIds(new Set(target.selectedNodeIds));
        setSelectedConnectionId(null);
        setViewport(target.viewport);
        setContextMenu(null);
        const applied: CanvasSnapshot = { ...target, projectId, domainProjectId, title: projectTitle, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: [...selectedNodeIdsRef.current], viewport: viewportRef.current };
        const trackedFields = result.trackedFields;
        undoStackRef.current = [...undoStackRef.current.slice(0, -1), { snapshot: current, afterSnapshot: applied, afterStateHash: hashCanvasAgentOperationSnapshot(applied, trackedFields), trackedFields, change: result.change }].slice(-10);
        setUndoOpsCount(undoStackRef.current.length);
        setRedoOpsCount(redoStackRef.current.length);
        setLastAgentChange({ ...result.change, undoCount: undoStackRef.current.length });
        return applied;
    }, [connectionsRef, domainProjectId, nodesRef, projectId, projectTitle, selectedNodeIdsRef, setConnections, setContextMenu, setNodes, setSelectedConnectionId, setSelectedNodeIds, setViewport, viewportRef]);

    const getAgentOperationHistory = useCallback((): CanvasAgentOperationHistory => {
        const current: CanvasSnapshot = { projectId, domainProjectId, title: projectTitle, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: [...selectedNodeIdsRef.current], viewport: viewportRef.current };
        const undo = undoStackRef.current.at(-1);
        const redo = redoStackRef.current.at(-1);
        return {
            undoable: undo && undo.afterStateHash === hashCanvasAgentOperationSnapshot(current, undo.trackedFields || { viewport: true, selection: true }) ? undoStackRef.current.slice(-10).reverse().map(({ change }) => ({ ...change })) : [],
            redoable: redo && redo.expectedStateHash === hashCanvasAgentOperationSnapshot(current, redo.trackedFields || { viewport: true, selection: true }) ? redoStackRef.current.slice(-10).reverse().map(({ change }) => ({ ...change })) : [],
        };
    }, [connectionsRef, domainProjectId, nodesRef, projectId, projectTitle, selectedNodeIdsRef, viewportRef]);

    const viewLastAgentChange = useCallback(() => {
        if (!lastAgentChange?.nodeIds.length) return;
        const ids = lastAgentChange.nodeIds.filter((id) => nodesRef.current.some((node) => node.id === id));
        if (!ids.length) return;
        const selection = new Set(ids);
        selectedNodeIdsRef.current = selection;
        setSelectedNodeIds(selection);
        setSelectedConnectionId(null);
        queueMicrotask(() => focusSelection());
    }, [focusSelection, lastAgentChange, nodesRef, selectedNodeIdsRef, setSelectedConnectionId, setSelectedNodeIds]);

    const undoBatch = undoStackRef.current.at(-1);
    const redoBatch = redoStackRef.current.at(-1);
    const canUndoAgentOps = undoOpsCount > 0 && Boolean(undoBatch && undoBatch.afterStateHash === hashCanvasAgentOperationSnapshot(snapshot, undoBatch.trackedFields || { viewport: true, selection: true }));
    const canRedoAgentOps = redoOpsCount > 0 && Boolean(redoBatch && redoBatch.expectedStateHash === hashCanvasAgentOperationSnapshot(snapshot, redoBatch.trackedFields || { viewport: true, selection: true }));

    return { agentSnapshot: snapshot, agentUndoCount: undoOpsCount, applyAgentOps: applyOps, recordAgentOperation, canUndoAgentOps, canRedoAgentOps, dismissLastAgentChange: () => setLastAgentChange(null), getAgentOperationHistory, lastAgentChange, redoAgentOps: redoOps, undoAgentOps: undoOps, viewLastAgentChange };
}

function agentAffectedNodeIds(ops: CanvasOperation[], nodes: CanvasNodeData[]) {
    const existingIds = new Set(nodes.map((node) => node.id));
    const ids = new Set<string>();
    ops.forEach((op) => {
        if ((op.type === "add_node" || op.type === "update_node" || op.type === "run_generation") && "id" in op && op.id && existingIds.has(op.id)) ids.add(op.id);
        if (op.type === "run_generation" && existingIds.has(op.nodeId)) ids.add(op.nodeId);
        if (op.type === "select_nodes") op.ids.filter((id) => existingIds.has(id)).forEach((id) => ids.add(id));
    });
    return [...ids];
}
