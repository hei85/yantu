import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";
import { nanoid } from "nanoid";

import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import {
    backendProviderConfig,
    buildGenerationConfig,
    generationTaskMetadata,
    pinCanvasVideoGenerationConfig,
    resetGenerationTaskMetadata,
    logicalModelIDForConfig,
} from "@/lib/canvas/canvas-project-generation";
import {
    cinematicStoryboardColumns,
    createCanvasNode,
    createStoryboardRow,
    expandStoryboardTextMentions,
    storyboardRowsFromTask,
    storyboardPromptTemplateMetadata,
} from "@/lib/canvas/canvas-project-domain";
import { buildNodeMentionReferences } from "@/lib/canvas/canvas-resource-references";
import { buildStoryboardAssetCatalog } from "@/lib/canvas/canvas-storyboard-assets";
import { resolveStoryboardGenerationContext } from "@/lib/canvas/canvas-storyboard-context";
import { reconcileStoryboardTargetConnections, storyboardComposerContent, storyboardRowReferenceNodeIds, storyboardVideoFrameNodeIds, storyboardVideoOperation, storyboardVideoPrompt } from "@/lib/canvas/canvas-storyboard-materializer";
import { generationErrorMessage } from "@/lib/generation-error";
import { navigateToSettings } from "@/lib/settings-navigation";
import type { Skill } from "@/services/api/skills";
import { createGenerationTask, waitForGenerationTask } from "@/services/api/task-center";
import { skillRuntime } from "@/services/skill-runtime";
import { StoryboardSubmissionUncertainError, submitStoryboardTask } from "@/services/storyboard-submission";
import { createCanvasAgentStoryboardNodeOperations, type CanvasAgentStoryboardGenerationResult } from "@/pages/canvas/canvas-agent-storyboard-node-operations";
import { preflightStoryboardMediaRows, type CanvasAgentStoryboardMediaGenerationInput, type CanvasAgentStoryboardMediaGenerationResult, type CanvasAgentStoryboardMediaPreflightInput, type CanvasAgentStoryboardMediaPreflightResult, type StoryboardMediaKind } from "@/pages/canvas/canvas-agent-storyboard-generation-preflight";
import { getActiveUserScope } from "@/lib/user-scope";
import { defaultConfig, modelDisplayName, resolveModelRequestConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import {
    CanvasNodeType,
    type CanvasConnection,
    type CanvasGenerationBatchMode,
    type CanvasNodeData,
    type StoryboardRow,
} from "@/types/canvas";

type UseCanvasStoryboardOptions = {
    projectId: string;
    addedSkills: Skill[];
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    enqueueGenerationBatch: (sourceNodeId: string, mode: CanvasGenerationBatchMode, targets: Array<{ rowId: string; nodeId: string }>, options?: { concurrency?: number; batchId?: string; clientOperationId?: string }) => string | undefined;
};

const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

export function useCanvasStoryboard({
    projectId,
    addedSkills,
    nodesRef,
    connectionsRef,
    setNodes,
    setConnections,
    setSelectedNodeIds,
    enqueueGenerationBatch,
}: UseCanvasStoryboardOptions) {
    const { message, modal } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const effectiveConfigRef = useRef(effectiveConfig);
    effectiveConfigRef.current = effectiveConfig;
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const storyboardRequests = useRef(new Set<string>());
    const storyboardOperationIds = useRef(new Map<string, string | undefined>());
    const storyboardLifetime = useRef(new AbortController());
    useEffect(() => {
        const controller = new AbortController();
        storyboardLifetime.current = controller;
        return () => controller.abort();
    }, [projectId]);

    const confirmGenerationSubmission = useCallback((count: number, model: string, taskLabel: string) => new Promise<boolean>((resolve) => {
        if (!count) return resolve(false);
        modal.confirm({
            title: `确认提交 ${count} 个${taskLabel}任务`,
            content: `任务数：${count}；模型：${modelDisplayName(effectiveConfig, model)}。当前没有可用的模型参数数据，将提交 ${count} 个外部模型任务。`,
            okText: "确认生成",
            cancelText: "取消",
            centered: true,
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
        });
    }), [effectiveConfig, modal]);

    const updateScriptRows = useCallback((nodeId: string, updater: (rows: StoryboardRow[]) => StoryboardRow[]) => {
        setNodes((current) => {
            const currentScript = current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
            if (!currentScript) return current;
            const previousRows = currentScript.metadata?.storyboard?.rows || [];
            const rows = updater(previousRows);
            const nextScript: CanvasNodeData = {
                ...currentScript,
                metadata: {
                    ...currentScript.metadata,
                    storyboard: {
                        rows,
                        visibleColumns: currentScript.metadata?.storyboard?.visibleColumns || ["shotNumber", "durationSeconds", "videoMotionPrompt", "dialogue", "assets"],
                        referenceNodeIds: currentScript.metadata?.storyboard?.referenceNodeIds || [],
                    },
                },
            };
            const rowByVideoNodeId = new Map(rows.filter((row) => row.videoNodeId).map((row) => [row.videoNodeId!, row]));
            const previousRowById = new Map(previousRows.map((row) => [row.id, row]));
            return current.map((node) => {
                if (node.id === nodeId) return nextScript;
                const row = rowByVideoNodeId.get(node.id);
                const previousRow = row ? previousRowById.get(row.id) : undefined;
                if (!row || !previousRow || node.type !== CanvasNodeType.Video) return node;
                // A storyboard edit may synchronize the pending prompt, but must not
                // rewrite a submitted/successful video node or its task result.
                if (node.metadata?.content || node.metadata?.taskId || node.metadata?.status === NODE_STATUS_LOADING || node.metadata?.status === NODE_STATUS_SUCCESS) return node;
                const prompt = storyboardVideoPrompt(row);
                const previousPrompt = storyboardVideoPrompt(previousRow);
                const operation = storyboardVideoOperation(row, node);
                if (prompt === previousPrompt && (!row.videoOperation || row.videoOperation === node.metadata?.videoEditOperation)) return node;
                const referenceIds = storyboardRowReferenceNodeIds(nextScript, row, current, connectionsRef.current, operation === "image_to_video", node.id);
                const composerContent = storyboardComposerContent(prompt, referenceIds, current);
                return { ...node, metadata: { ...node.metadata, prompt, composerContent, ...storyboardPromptTemplateMetadata(row, "video"), ...(row.videoOperation ? { videoEditOperation: row.videoOperation } : {}) } };
            });
        });
    }, [connectionsRef, setNodes]);

    const replaceScriptRows = useCallback((nodeId: string, rows: StoryboardRow[]) => {
        const rowIds = new Set(rows.map((row) => `row:${row.id}`));
        const storyboardRowIds = new Set(rows.map((row) => row.id));
        const previousRows = new Map((nodesRef.current.find((node) => node.id === nodeId)?.metadata?.storyboard?.rows || []).map((row) => [row.id, row]));
        const nextRows = rows.map((row) => invalidateEditedPromptVariables(previousRows.get(row.id), row));
        setConnections((current) => current
            .filter((connection) => connection.fromNodeId !== nodeId && connection.toNodeId !== nodeId || !connection.storyboardRowId || storyboardRowIds.has(connection.storyboardRowId))
            .filter((connection) => connection.fromNodeId !== nodeId || !connection.fromHandleId?.startsWith("row:") || rowIds.has(connection.fromHandleId))
            .filter((connection) => connection.toNodeId !== nodeId || !connection.toHandleId?.startsWith("row:") || rowIds.has(connection.toHandleId)));
        updateScriptRows(nodeId, () => nextRows);
    }, [nodesRef, setConnections, updateScriptRows]);

    const addScriptRow = useCallback((nodeId: string) => {
        updateScriptRows(nodeId, (rows) => [...rows, createStoryboardRow(rows.length + 1)]);
    }, [updateScriptRows]);

    const updateScriptRow = useCallback((nodeId: string, rowId: string, patch: Partial<StoryboardRow>) => {
        updateScriptRows(nodeId, (rows) => rows.map((row) => row.id === rowId ? invalidateEditedPromptVariables(row, { ...row, ...patch }) : row));
    }, [updateScriptRows]);

    const removeScriptRow = useCallback((nodeId: string, rowId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        const rows = (node?.metadata?.storyboard?.rows || []).filter((row) => row.id !== rowId).map((row, index) => ({ ...row, shotNumber: index + 1 }));
        replaceScriptRows(nodeId, rows);
    }, [nodesRef, replaceScriptRows]);

    const generateScriptRows = useCallback(async (nodeId: string, prompt: string, callerSignal?: AbortSignal, clientOperationId?: string, agentPrecondition?: () => Promise<void>, onApprovedQuote?: (quote: { model: string; expiresAt: string; options?: Record<string, unknown> }) => void) => {
        const scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        if (!scriptNode || !prompt.trim()) return;
        if (storyboardRequests.current.has(nodeId) || (scriptNode.metadata?.status === NODE_STATUS_LOADING && scriptNode.metadata?.taskClientOperationId !== clientOperationId)) { message.warning("当前分镜正在处理，请等待原任务完成或使用相同 clientOperationId 恢复"); return false; }
        const lifetimeSignal = storyboardLifetime.current.signal;
        const signal = callerSignal ? AbortSignal.any([lifetimeSignal, callerSignal]) : lifetimeSignal;
        const scope = getActiveUserScope();
        const originalRows = JSON.stringify(scriptNode.metadata?.storyboard?.rows || []);
        const assertCurrent = () => {
            signal.throwIfAborted();
            const current = nodesRef.current.find((node) => node.id === nodeId);
            if (getActiveUserScope() !== scope || !current || JSON.stringify(current.metadata?.storyboard?.rows || []) !== originalRows) throw new Error("画布、账号或分镜内容已变化，未覆盖现有镜头，请重新读取后处理");
        };
        let storyboardContext: ReturnType<typeof resolveStoryboardGenerationContext>;
        try {
            storyboardContext = resolveStoryboardGenerationContext(nodesRef.current);
        } catch (error) {
            message.warning(error instanceof Error ? error.message : "分镜上下文不完整");
            return;
        }
        const shotDuration = scriptNode.metadata?.storyboardShotDuration || "auto";
        const shotDurationSeconds = shotDuration === "auto" ? 0 : Number(shotDuration);
        const shotCount = scriptNode.metadata?.storyboardShotCount || "auto";
        const requestedShotCount = shotCount === "auto" ? 0 : Number(shotCount);
        const expandedPrompt = expandStoryboardTextMentions(prompt, buildNodeMentionReferences(scriptNode, nodesRef.current, connectionsRef.current));
        const generationConfig = buildGenerationConfig(effectiveConfig, scriptNode, "text");
        if (!isAiConfigReady(generationConfig, generationConfig.model)) {
            navigateToSettings({ continueCreation: true });
            return;
        }
        storyboardRequests.current.add(nodeId);
        storyboardOperationIds.current.set(nodeId, clientOperationId);
        try {
            const skillExecution = await skillRuntime.prepare({
                profile: "shortDrama",
                prompt: expandedPrompt,
                skills: addedSkills,
            });
            await agentPrecondition?.();
            assertCurrent();
            setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...(clientOperationId && node.metadata?.taskClientOperationId !== clientOperationId ? { taskId: undefined, taskStatus: undefined, taskStage: undefined } : {}), composerContent: prompt, ...(clientOperationId ? { taskClientOperationId: clientOperationId } : {}), status: NODE_STATUS_LOADING, taskStage: "正在创建任务", taskProgress: 0, errorDetails: undefined, ...skillExecution.metadata } } : node));
            assertCurrent();
            const request = {
                projectId,
                type: "canvas_text",
                operation: "storyboard",
                prompt: skillExecution.prompt,
                model: generationConfig.model,
                ...(logicalModelIDForConfig(generationConfig) ? { logicalModelId: logicalModelIDForConfig(generationConfig) } : {}),
                input: {
                    mode: "text",
                    prompt: skillExecution.prompt,
                    canvasAssets: buildStoryboardAssetCatalog(nodesRef.current),
                    requirements: "输出可直接编辑并用于批量生成图片和视频的分镜表。characters 中的 characterId 和 voiceVersionId 必须沿用已给定角色身份；只有已绑定时才带 voiceVersionId。该引用是声音连续性的唯一身份依据，禁止逐镜重新设计音色。",
                    projectStyle: storyboardContext.projectStyle,
                    characters: storyboardContext.characters,
                    shotDurationSeconds,
                    shotCount: requestedShotCount,
                    config: backendProviderConfig(generationConfig, "text"),
                    metadata: { nodeId, ...skillExecution.metadata },
                },
            };
            const managed = Boolean(logicalModelIDForConfig(generationConfig) || resolveModelRequestConfig(generationConfig, generationConfig.model).channelId);
            const task = managed ? await submitStoryboardTask(request, { signal, assertCurrent, clientOperationId, confirm: async (submission) => {
                await agentPrecondition?.();
                const quote = submission.quote;
                const approved = await new Promise<boolean>((resolve) => {
                const dialog = modal.confirm({
                    title: "确认生成分镜",
                    content: `使用 ${modelDisplayName(effectiveConfig, quote.model)} 拆分镜头。${(scriptNode.metadata?.storyboard?.rows || []).length ? "本次将替换现有分镜行，原图片视频保留，镜头关联需要重新核对。" : "确认后生成可编辑的分镜表。"}`,
                    okText: "确认生成", cancelText: "取消", centered: true,
                    onOk: () => resolve(true), onCancel: () => resolve(false),
                    afterClose: () => signal.removeEventListener("abort", cancel),
                });
                const cancel = () => { dialog.destroy(); resolve(false); };
                signal.addEventListener("abort", cancel, { once: true });
                if (signal.aborted) cancel();
                });
                if (approved) await agentPrecondition?.();
                if (approved) onApprovedQuote?.({ model: quote.model, expiresAt: quote.expiresAt, ...(quote.options ? { options: structuredClone(quote.options) } : {}) });
                return approved;
            } }) : await (async () => {
                const confirmed = await confirmGenerationSubmission(1, generationConfig.model, `专业拆镜${(scriptNode.metadata?.storyboard?.rows || []).length ? "（替换现有镜头，保留原媒体）" : ""}`);
                if (!confirmed) return undefined;
                assertCurrent();
                return createGenerationTask(request);
            })();
            if (!task) {
                if (!signal.aborted && scope === getActiveUserScope()) setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: scriptNode.metadata?.status || NODE_STATUS_IDLE, taskStage: undefined } } : node));
                return false;
            }
            assertCurrent();
            setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...generationTaskMetadata(task), status: NODE_STATUS_LOADING } } : node));
            const completed = await waitForGenerationTask(task.id, {
                initialTask: task,
                signal,
                useTextEvents: true,
                onTaskUpdate: (next) => { if (!signal.aborted && scope === getActiveUserScope()) setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...generationTaskMetadata(next), status: NODE_STATUS_LOADING } } : node)); },
            });
            const result = storyboardRowsFromTask(completed);
            assertCurrent();
            replaceScriptRows(nodeId, result.rows);
            setNodes((current) => current.map((node) => node.id === nodeId ? {
                ...node,
                title: result.title || node.title,
                metadata: {
                    ...node.metadata,
                    status: NODE_STATUS_SUCCESS,
                    errorDetails: undefined,
                    ...generationTaskMetadata(completed),
                    storyboard: {
                        rows: result.rows,
                        visibleColumns: cinematicStoryboardColumns(node.metadata?.storyboard?.visibleColumns),
                        referenceNodeIds: node.metadata?.storyboard?.referenceNodeIds || [],
                    },
                },
            } : node));
            message.success(`已生成 ${result.rows.length} 个镜头`);
            return { taskId: completed.id, rowIds: result.rows.map((row) => row.id) };
        } catch (error) {
            if (signal.aborted || scope !== getActiveUserScope()) return false;
            const details = generationErrorMessage(error);
            setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: details } } : node));
            message.error(details);
            if (clientOperationId) throw error;
            return false;
        } finally {
            if (signal.aborted && !lifetimeSignal.aborted && scope === getActiveUserScope()) setNodes((current) => current.map((node) => {
                if (node.id !== nodeId) return node;
                const active = node.metadata?.taskStatus === "queued" || node.metadata?.taskStatus === "running";
                return { ...node, metadata: { ...node.metadata, status: active ? NODE_STATUS_LOADING : NODE_STATUS_IDLE, taskStage: active ? "已提交后台任务，等待结果" : undefined } };
            }));
            storyboardRequests.current.delete(nodeId);
            storyboardOperationIds.current.delete(nodeId);
        }
    }, [addedSkills, confirmGenerationSubmission, connectionsRef, effectiveConfig, isAiConfigReady, message, modal, nodesRef, projectId, replaceScriptRows, setNodes]);

    const agentGenerateScriptRows = useCallback(async (input: { nodeId: string; prompt: string; clientOperationId: string }, beforeCommit: () => Promise<void>): Promise<CanvasAgentStoryboardGenerationResult> => {
        if (!input.nodeId?.trim() || !input.prompt?.trim()) throw new Error("必须指定真实 Script 节点和拆镜提示词");
        const operationId = typeof input.clientOperationId === "string" ? input.clientOperationId.trim() : "";
        if (!operationId || operationId.length > 109) throw new Error("clientOperationId 必须是 1 至 109 字符的稳定标识");
        if (storyboardRequests.current.has(input.nodeId)) {
            if (storyboardOperationIds.current.get(input.nodeId) === operationId) {
                const runningNode = nodesRef.current.find((node) => node.id === input.nodeId && node.type === CanvasNodeType.Script);
                return { nodeId: input.nodeId, clientOperationId: operationId, status: "running", ...(runningNode?.metadata?.taskClientOperationId === operationId && runningNode.metadata.taskId ? { taskId: runningNode.metadata.taskId } : {}), rowIds: [], rows: structuredClone(runningNode?.metadata?.storyboard?.rows || []), revisionHint: runningNode?.updatedAt || null };
            }
            throw new Error("当前 Script 节点已有另一拆镜操作运行；请等待原操作并复用其 clientOperationId");
        }
        const before = nodesRef.current.find((node) => node.id === input.nodeId && node.type === CanvasNodeType.Script);
        if (!before) throw new Error(`分镜 Script 节点不存在：${input.nodeId}`);
        const config = buildGenerationConfig(effectiveConfig, before, "text");
        const managed = Boolean(logicalModelIDForConfig(config) || resolveModelRequestConfig(config, config.model).channelId);
        if (!managed) throw new Error("Agent 拆镜仅开放有报价/确认与稳定任务幂等的托管提交路径；当前模型通道不满足条件，未提交任务");
        if (!isAiConfigReady(config, config.model)) throw new Error("拆镜模型配置未就绪，未提交外部任务");
        const priorRows = new Set((before.metadata?.storyboard?.rows || []).map((row) => row.id));
        await beforeCommit();
        let completed: Awaited<ReturnType<typeof generateScriptRows>>;
        let confirmedQuote: CanvasAgentStoryboardGenerationResult["confirmedQuote"];
        try {
            completed = await generateScriptRows(input.nodeId, input.prompt, undefined, operationId, beforeCommit, (quote) => { confirmedQuote = quote; });
        } catch (error) {
            const current = nodesRef.current.find((node) => node.id === input.nodeId && node.type === CanvasNodeType.Script);
            const taskId = current?.metadata?.taskClientOperationId === operationId ? current.metadata.taskId : undefined;
            if (error instanceof StoryboardSubmissionUncertainError) {
                return { nodeId: input.nodeId, clientOperationId: operationId, status: "uncertain", ...(taskId ? { taskId } : {}), rowIds: [], rows: structuredClone(current?.metadata?.storyboard?.rows || []), revisionHint: current?.updatedAt || null, error: error.message };
            }
            return { nodeId: input.nodeId, clientOperationId: operationId, status: "failed", ...(taskId ? { taskId } : {}), rowIds: [], rows: structuredClone(current?.metadata?.storyboard?.rows || []), revisionHint: current?.updatedAt || null, error: error instanceof Error ? error.message : String(error) };
        }
        const current = nodesRef.current.find((node) => node.id === input.nodeId && node.type === CanvasNodeType.Script);
        if (!current) throw new Error("分镜生成后 Script 节点已不存在");
        const rows = current.metadata?.storyboard?.rows || [];
        const generated = completed && typeof completed === "object" ? completed : undefined;
        const rowIds = generated?.rowIds || rows.filter((row) => !priorRows.has(row.id)).map((row) => row.id);
        const taskId = current.metadata?.taskClientOperationId === operationId ? current.metadata?.taskId : undefined;
        const status = generated ? "completed" as const
            : current.metadata?.errorDetails?.includes("状态不确定") ? "uncertain" as const
                : current.metadata?.status === NODE_STATUS_ERROR ? "failed" as const
                    : current.metadata?.status === NODE_STATUS_LOADING && current.metadata?.taskClientOperationId === operationId ? "running" as const
                        : "cancelled" as const;
        return { nodeId: input.nodeId, clientOperationId: operationId, status, ...(taskId ? { taskId } : {}), rowIds, rows: structuredClone(rows), revisionHint: current.updatedAt || null, ...(confirmedQuote ? { confirmedQuote } : {}), ...(current.metadata?.errorDetails ? { error: current.metadata.errorDetails } : {}) };
    }, [effectiveConfig, generateScriptRows, isAiConfigReady, nodesRef]);

    const agentPreflightScriptMedia = useCallback((input: CanvasAgentStoryboardMediaPreflightInput): CanvasAgentStoryboardMediaPreflightResult => {
        const scriptNode = nodesRef.current.find((node) => node.id === input.nodeId && node.type === CanvasNodeType.Script);
        if (!scriptNode) throw new Error(`分镜 Script 节点不存在：${input.nodeId}`);
        const generationConfig = buildGenerationConfig(effectiveConfigRef.current, undefined, input.kind === "image" ? "image" : "video");
        const model = generationConfig.model;
        const preflightRows = preflightStoryboardMediaRows({
            rows: scriptNode.metadata?.storyboard?.rows || [],
            nodes: nodesRef.current,
            rowIds: input.rowIds,
            kind: input.kind,
            modelReady: isAiConfigReady(generationConfig, model),
            idempotentSubmissionAvailable: true,
            allowMissingMediaNode: true,
            assetNodeIdsByRow: Object.fromEntries((scriptNode.metadata?.storyboard?.rows || []).map((row) => [
                row.id,
                storyboardRowReferenceNodeIds(scriptNode, row, nodesRef.current, connectionsRef.current, input.kind === "video"),
            ])),
        });
        const usesKeyframe = input.kind === "video" && scriptNode.metadata?.storyboardVideoInputMode === "keyframe";
        const rows = usesKeyframe ? preflightRows.map((item) => {
            if (item.status !== "ready") return item;
            const row = scriptNode.metadata?.storyboard?.rows?.find((candidate) => candidate.id === item.rowId);
            const image = row?.imageNodeId ? nodesRef.current.find((node) => node.id === row.imageNodeId && node.type === CanvasNodeType.Image) : undefined;
            return image?.metadata?.content ? item : { ...item, status: "blocked" as const, reason: "关键帧视频需要已生成的首帧图片" };
        }) : preflightRows;
        return {
            nodeId: input.nodeId,
            kind: input.kind,
            model,
            status: rows.some((row) => row.status === "blocked") ? "blocked" as const : rows.some((row) => row.status === "running") ? "running" as const : "ready" as const,
            rows,
            submitted: false as const,
            reason: rows.some((row) => row.status === "blocked") ? "存在阻塞项；未提交任何收费任务" : undefined,
        };
    }, [connectionsRef, effectiveConfig, isAiConfigReady, nodesRef]);

    const ensureScriptImageNodes = useCallback((nodeId: string, rowIds: string[]) => {
        const scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        const rows = (scriptNode?.metadata?.storyboard?.rows || []).filter((row) => rowIds.includes(row.id));
        if (!scriptNode || !rows.length) return [];
        const imageSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const startX = scriptNode.position.x + scriptNode.width + 120;
        const nextNodes = [...nodesRef.current];
        let nextConnections = [...connectionsRef.current];
        const targets: Array<{ row: StoryboardRow; node: CanvasNodeData; prompt: string }> = [];
        rows.forEach((row, index) => {
            const prompt = (row.imageGenerationPrompt || row.plotDescription).trim();
            const existing = row.imageNodeId ? nextNodes.find((node) => node.id === row.imageNodeId && node.type === CanvasNodeType.Image) : undefined;
            const existingMetadata = existing?.metadata?.content ? existing.metadata : resetGenerationTaskMetadata(existing?.metadata);
            const referenceIds = storyboardRowReferenceNodeIds(scriptNode, row, nextNodes, nextConnections, false, existing?.id);
            const composerContent = storyboardComposerContent(prompt, referenceIds, nextNodes);
            const imageNode = existing
                ? { ...existing, metadata: { ...existingMetadata, prompt, composerContent, ...storyboardPromptTemplateMetadata(row, "image"), workflowKind: "shot" as const, workflowTitle: `镜头 ${row.shotNumber} 分镜图`, shotIndex: row.shotNumber } }
                : createCanvasNode(CanvasNodeType.Image, { x: startX + imageSpec.width / 2, y: scriptNode.position.y + index * (imageSpec.height + 36) + imageSpec.height / 2 }, { prompt, composerContent, ...storyboardPromptTemplateMetadata(row, "image"), workflowKind: "shot", workflowTitle: `镜头 ${row.shotNumber} 分镜图`, shotIndex: row.shotNumber, status: NODE_STATUS_IDLE });
            if (!existing) {
                imageNode.title = `镜头 ${row.shotNumber} · 分镜图`;
                nextNodes.push(imageNode);
            } else {
                const existingIndex = nextNodes.findIndex((node) => node.id === existing.id);
                nextNodes[existingIndex] = imageNode;
            }
            nextConnections = reconcileStoryboardTargetConnections(nextConnections, scriptNode, row, imageNode.id, referenceIds, "image");
            targets.push({ row, node: imageNode, prompt });
        });
        const imageNodeByRowId = new Map(targets.map((target) => [target.row.id, target.node.id]));
        const scriptIndex = nextNodes.findIndex((node) => node.id === scriptNode.id);
        nextNodes[scriptIndex] = {
            ...scriptNode,
            metadata: {
                ...scriptNode.metadata,
                storyboard: {
                    rows: (scriptNode.metadata?.storyboard?.rows || []).map((row) => ({ ...row, imageNodeId: imageNodeByRowId.get(row.id) || row.imageNodeId })),
                    visibleColumns: scriptNode.metadata?.storyboard?.visibleColumns || ["shotNumber", "durationSeconds", "videoMotionPrompt", "dialogue", "assets"],
                    referenceNodeIds: scriptNode.metadata?.storyboard?.referenceNodeIds || [],
                },
            },
        };
        nodesRef.current = nextNodes;
        connectionsRef.current = nextConnections;
        setNodes(nextNodes);
        setConnections(nextConnections);
        return targets;
    }, [connectionsRef, nodesRef, setConnections, setNodes]);

    const createScriptImageNodes = useCallback((nodeId: string, rowIds?: string[]) => {
        const scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        const rows = scriptNode?.metadata?.storyboard?.rows || [];
        const selectedRows = rowIds?.length ? rows.filter((row) => rowIds.includes(row.id)) : rows;
        if (!scriptNode || !selectedRows.length) return;
        const missing = selectedRows.filter((row) => !(row.imageGenerationPrompt || row.plotDescription).trim());
        if (missing.length) { message.warning(`有 ${missing.length} 个镜头缺少画面描述或图片提示词`); return; }
        const createdCount = selectedRows.filter((row) => !row.imageNodeId || !nodesRef.current.some((node) => node.id === row.imageNodeId && node.type === CanvasNodeType.Image)).length;
        ensureScriptImageNodes(nodeId, selectedRows.map((row) => row.id));
        message.success(createdCount ? `已创建 ${createdCount} 个图片节点` : "已同步现有图片节点的提示词");
    }, [ensureScriptImageNodes, message, nodesRef]);

    const generateScriptImages = useCallback(async (nodeId: string, rowIds: string[], options?: { skipConfirmation?: boolean; clientOperationId?: string }) => {
        const scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        const rows = (scriptNode?.metadata?.storyboard?.rows || []).filter((row) => rowIds.includes(row.id));
        if (!scriptNode || !rows.length) return;
        const missing = rows.filter((row) => !(row.imageGenerationPrompt || row.plotDescription).trim());
        if (missing.length) { message.warning(`有 ${missing.length} 个镜头缺少画面描述或图片提示词`); return; }
        const imageModel = effectiveConfig.imageModel || effectiveConfig.model;
        if (!isAiConfigReady(effectiveConfig, imageModel)) {
            navigateToSettings({ continueCreation: true });
            return;
        }
        const activeNodeIds = activeGenerationBatchNodeIds(scriptNode, "storyboard_image");
        const targetRows = rows.filter((row) => {
            const imageNode = row.imageNodeId ? nodesRef.current.find((node) => node.id === row.imageNodeId && node.type === CanvasNodeType.Image) : undefined;
            return !imageNode?.metadata?.content && (!imageNode || !activeNodeIds.has(imageNode.id));
        });
        if (!targetRows.length) { message.info("所选分镜图已生成或正在生成"); return; }
        if (!options?.skipConfirmation && !await confirmGenerationSubmission(targetRows.length, imageModel, "图片生成")) return;
        const targets = ensureScriptImageNodes(nodeId, targetRows.map((row) => row.id));
        const batchId = enqueueGenerationBatch(nodeId, "storyboard_image", targets.map((target) => ({ rowId: target.row.id, nodeId: target.node.id })), options?.clientOperationId ? { clientOperationId: options.clientOperationId } : undefined);
        if (batchId) message.success("分镜图已加入生成队列");
        return batchId;
    }, [effectiveConfig, enqueueGenerationBatch, ensureScriptImageNodes, confirmGenerationSubmission, isAiConfigReady, message, nodesRef]);

    const createScriptVideoNodes = useCallback((nodeId: string, silent = false, rowIds?: string[]) => {
        const scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        const allRows = scriptNode?.metadata?.storyboard?.rows || [];
        const rows = rowIds?.length ? allRows.filter((row) => rowIds.includes(row.id)) : allRows;
        if (!scriptNode || !rows.length) return;
        const videoSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
        const startLeft = scriptNode.position.x + scriptNode.width + 120;
        const videoModel = buildGenerationConfig(effectiveConfig, undefined, "video").model;
        const nextNodes = [...nodesRef.current];
        let nextConnections = [...connectionsRef.current];
        const videoNodeByRowId = new Map<string, string>();
        let createdCount = 0;
        rows.forEach((row, index) => {
            const prompt = storyboardVideoPrompt(row);
            const existingIndex = row.videoNodeId ? nextNodes.findIndex((node) => node.id === row.videoNodeId && node.type === CanvasNodeType.Video) : -1;
            const existing = existingIndex >= 0 ? nextNodes[existingIndex] : undefined;
            const videoOperation = storyboardVideoOperation(row, existing);
            const frameNodeIds = storyboardVideoFrameNodeIds(row, existing).filter((id) => nextNodes.some((node) => node.id === id));
            const referenceIds = [...new Set([
                ...storyboardRowReferenceNodeIds(scriptNode, row, nextNodes, nextConnections, videoOperation === "image_to_video", existing?.id),
                ...frameNodeIds,
            ])];
            const composerContent = storyboardComposerContent(prompt, referenceIds, nextNodes);
            if (existingIndex >= 0) {
                const existing = nextNodes[existingIndex];
                if (existing.metadata?.content) {
                    videoNodeByRowId.set(row.id, existing.id);
                    return;
                }
                const existingMetadata = existing.metadata || {};
                nextNodes[existingIndex] = { ...existing, metadata: { ...existingMetadata, prompt, composerContent, model: videoModel, ...storyboardPromptTemplateMetadata(row, "video"), seconds: String(row.durationSeconds), shotIndex: row.shotNumber, workflowKind: "shot", workflowTitle: `镜头 ${row.shotNumber} 视频`, generationMode: "video", videoEditOperation: videoOperation, videoStartFrameNodeId: existing.metadata?.videoStartFrameNodeId || (videoOperation === "image_to_video" ? row.imageNodeId : undefined), videoEndFrameNodeId: existing.metadata?.videoEndFrameNodeId } };
                nextConnections = reconcileStoryboardTargetConnections(nextConnections, scriptNode, row, existing.id, referenceIds);
                videoNodeByRowId.set(row.id, existing.id);
                return;
            }
            const videoNode = createCanvasNode(CanvasNodeType.Video, { x: startLeft + videoSpec.width / 2, y: scriptNode.position.y + index * (videoSpec.height + 36) + videoSpec.height / 2 }, { prompt, composerContent, model: videoModel, ...storyboardPromptTemplateMetadata(row, "video"), workflowKind: "shot", workflowTitle: `镜头 ${row.shotNumber} 视频`, shotIndex: row.shotNumber, generationMode: "video", videoEditOperation: videoOperation, videoStartFrameNodeId: videoOperation === "image_to_video" ? row.imageNodeId : undefined, status: NODE_STATUS_IDLE, seconds: String(row.durationSeconds) });
            videoNode.title = `镜头 ${row.shotNumber} · 视频`;
            nextNodes.push(videoNode);
            nextConnections = reconcileStoryboardTargetConnections(nextConnections, scriptNode, row, videoNode.id, referenceIds);
            videoNodeByRowId.set(row.id, videoNode.id);
            createdCount += 1;
        });
        const scriptIndex = nextNodes.findIndex((node) => node.id === scriptNode.id);
        nextNodes[scriptIndex] = {
            ...scriptNode,
            metadata: {
                ...scriptNode.metadata,
                storyboard: {
                    rows: allRows.map((row) => ({ ...row, videoNodeId: videoNodeByRowId.get(row.id) || row.videoNodeId })),
                    visibleColumns: scriptNode.metadata?.storyboard?.visibleColumns || ["shotNumber", "durationSeconds", "videoMotionPrompt", "dialogue", "assets"],
                    referenceNodeIds: scriptNode.metadata?.storyboard?.referenceNodeIds || [],
                },
            },
        };
        nodesRef.current = nextNodes;
        connectionsRef.current = nextConnections;
        setNodes(nextNodes);
        setConnections(nextConnections);
        if (!silent) message.success(createdCount ? `已创建 ${createdCount} 个视频节点` : "已同步现有视频节点的提示词");
    }, [connectionsRef, effectiveConfig, message, nodesRef, setConnections, setNodes]);

    const agentStoryboardNodeOperations = createCanvasAgentStoryboardNodeOperations({ nodesRef, connectionsRef, createScriptImageNodes, createScriptVideoNodes });

    const createAndGenerateScriptVideos = useCallback(async (nodeId: string, rowIds?: string[], options?: { skipConfirmation?: boolean; clientOperationId?: string }) => {
        const submissionConfig = effectiveConfigRef.current;
        const videoModel = submissionConfig.videoModel || submissionConfig.model;
        if (!isAiConfigReady(submissionConfig, videoModel)) {
            navigateToSettings({ continueCreation: true });
            return;
        }
        let scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        const allRows = scriptNode?.metadata?.storyboard?.rows || [];
        const rows = rowIds?.length ? allRows.filter((row) => rowIds.includes(row.id)) : allRows;
        const describedRows = rows.filter((row) => Boolean((row.videoMotionPrompt || row.plotDescription).trim()));
        const activeNodeIds = scriptNode ? activeGenerationBatchNodeIds(scriptNode, "storyboard_video") : new Set<string>();
        const targetRows = describedRows.filter((row) => {
            const videoNode = row.videoNodeId ? nodesRef.current.find((node) => node.id === row.videoNodeId && node.type === CanvasNodeType.Video) : undefined;
            return !videoNode?.metadata?.content && (!videoNode || !activeNodeIds.has(videoNode.id));
        });
        if (!targetRows.length) {
            if (describedRows.some((row) => row.videoNodeId && nodesRef.current.some((node) => node.id === row.videoNodeId && Boolean(node.metadata?.content)))) message.info("镜头视频已存在");
            else message.warning("请先补充镜头画面描述");
            return;
        }
        if (!options?.skipConfirmation && !await confirmGenerationSubmission(targetRows.length, videoModel, "视频生成")) return;
        createScriptVideoNodes(nodeId, true, targetRows.map((row) => row.id));
        scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        const targetRowIds = new Set(targetRows.map((row) => row.id));
        const targets = rows.flatMap((row) => {
            if (!targetRowIds.has(row.id)) return [];
            const currentRow = scriptNode?.metadata?.storyboard?.rows.find((item) => item.id === row.id) || row;
            const videoNode = currentRow.videoNodeId ? nodesRef.current.find((node) => node.id === currentRow.videoNodeId && node.type === CanvasNodeType.Video) : undefined;
            if (!videoNode || videoNode.metadata?.content) return [];
            const prompt = storyboardVideoPrompt(currentRow);
            if (!prompt) return [];
            return [{ row: currentRow, videoNode, prompt }];
        });
        const targetById = new Map(targets.map((target) => [target.videoNode.id, target]));
        const nextNodes = nodesRef.current.map((node) => {
            const target = targetById.get(node.id);
            if (!target) return node;
            const configuredNode = {
                ...node,
                metadata: {
                    ...node.metadata,
                    prompt: target.prompt,
                    composerContent: target.videoNode.metadata?.composerContent || target.prompt,
                    model: videoModel,
                    ...storyboardPromptTemplateMetadata(target.row, "video"),
                    generationMode: "video" as const,
                    videoEditOperation: storyboardVideoOperation(target.row, target.videoNode),
                },
            };
            return pinCanvasVideoGenerationConfig(submissionConfig, configuredNode);
        });
        const nextConnections = connectionsRef.current;
        nodesRef.current = nextNodes;
        connectionsRef.current = nextConnections;
        setNodes(nextNodes);
        setConnections(nextConnections);
        setSelectedNodeIds(new Set(targets.map((target) => target.videoNode.id)));
        const batchId = enqueueGenerationBatch(nodeId, "storyboard_video", targets.map((target) => ({ rowId: target.row.id, nodeId: target.videoNode.id })), options?.clientOperationId ? { clientOperationId: options.clientOperationId } : undefined);
        if (batchId) message.success("镜头视频已加入生成队列");
        return batchId;
    }, [connectionsRef, confirmGenerationSubmission, createScriptVideoNodes, effectiveConfig, enqueueGenerationBatch, isAiConfigReady, message, nodesRef, setConnections, setNodes, setSelectedNodeIds]);

    const createScriptActionBoards = useCallback(async (nodeId: string) => {
        const scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        const rows = scriptNode?.metadata?.storyboard?.rows || [];
        if (!scriptNode || !rows.length) return;
        const imageModel = effectiveConfig.imageModel || effectiveConfig.model;
        if (!isAiConfigReady(effectiveConfig, imageModel)) {
            navigateToSettings({ continueCreation: true });
            return;
        }
        const actionBoardRows = rows.filter((row) => !nodesRef.current.some((node) => node.type === CanvasNodeType.Image && node.metadata?.workflowKind === "action_board" && node.metadata.shotIndex === row.shotNumber && Boolean(node.metadata.content)));
        if (!actionBoardRows.length) {
            message.info("动作拆分板已存在");
            return;
        }
        if (!await confirmGenerationSubmission(actionBoardRows.length, imageModel, "动作板生成")) return;
        const imageSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const startX = scriptNode.position.x + scriptNode.width + 120;
        const nextNodes = [...nodesRef.current];
        const nextConnections = [...connectionsRef.current];
        const targets: Array<{ row: StoryboardRow; node: CanvasNodeData; prompt: string }> = [];
        actionBoardRows.forEach((row, index) => {
            const prompt = [
                "生成一张电影动作拆分 12 宫格参考图，严格 3 列 4 行，12 个格子清晰分隔，保持同一角色、服装、场景和光线连续。",
                `镜头 ${row.shotNumber}：${row.plotDescription || row.videoMotionPrompt || "根据镜头剧情补全动作"}`,
                row.characters.length ? `角色：${row.characters.map((item) => item.characterName).join("、")}` : "",
                "按时间顺序展示动作起势、推进、转折、落点和结束姿态，不要添加文字、边框标题或额外画面。",
            ].filter(Boolean).join("\n");
            const existingIndex = nextNodes.findIndex((node) => node.type === CanvasNodeType.Image && node.metadata?.workflowKind === "action_board" && node.metadata.shotIndex === row.shotNumber);
            if (existingIndex >= 0 && nextNodes[existingIndex].metadata?.content) return;
            const imageNode = existingIndex >= 0
                ? { ...nextNodes[existingIndex], metadata: { ...resetGenerationTaskMetadata(nextNodes[existingIndex].metadata), prompt } }
                : createCanvasNode(CanvasNodeType.Image, { x: startX + imageSpec.width / 2, y: scriptNode.position.y + index * (imageSpec.height + 36) + imageSpec.height / 2 }, { prompt, workflowKind: "action_board", workflowTitle: `镜头 ${row.shotNumber} 动作板`, shotIndex: row.shotNumber, actionBoardRows: 4, actionBoardColumns: 3, status: NODE_STATUS_IDLE });
            imageNode.title = `镜头 ${row.shotNumber} · 动作板`;
            if (existingIndex >= 0) nextNodes[existingIndex] = imageNode;
            else {
                nextNodes.push(imageNode);
                nextConnections.push({ id: nanoid(), fromNodeId: scriptNode.id, toNodeId: imageNode.id, fromHandleId: `row:${row.id}` });
            }
            targets.push({ row, node: imageNode, prompt });
        });
        nodesRef.current = nextNodes;
        connectionsRef.current = nextConnections;
        setNodes(nextNodes);
        setConnections(nextConnections);
        if (enqueueGenerationBatch(nodeId, "action_board", targets.map((target) => ({ rowId: target.row.id, nodeId: target.node.id })))) message.success("动作拆分板已加入生成队列");
    }, [connectionsRef, confirmGenerationSubmission, effectiveConfig, enqueueGenerationBatch, isAiConfigReady, message, nodesRef, setConnections, setNodes]);

    const generateScriptVideos = useCallback(async (nodeId: string, rowIds: string[], options?: { skipConfirmation?: boolean; clientOperationId?: string }) => {
        const submissionConfig = effectiveConfigRef.current;
        let scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        const rows = (scriptNode?.metadata?.storyboard?.rows || []).filter((row) => rowIds.includes(row.id));
        if (!scriptNode || !rows.length) return;
        const readyRows = rows.filter((row) => row.imageNodeId && nodesRef.current.some((node) => node.id === row.imageNodeId && node.type === CanvasNodeType.Image && node.metadata?.content));
        if (!readyRows.length) { message.warning("请先生成并检查选中镜头的首帧"); return; }
        if (readyRows.length !== rows.length) { message.warning(`${rows.length - readyRows.length} 个选中镜头还没有可用首帧，请全部生成并检查后再确认`); return; }
        const videoModel = submissionConfig.videoModel || submissionConfig.model;
        if (!isAiConfigReady(submissionConfig, videoModel)) {
            navigateToSettings({ continueCreation: true });
            return;
        }
        const activeNodeIds = activeGenerationBatchNodeIds(scriptNode, "storyboard_video");
        const targetRows = readyRows.filter((row) => {
            const videoNode = row.videoNodeId ? nodesRef.current.find((node) => node.id === row.videoNodeId && node.type === CanvasNodeType.Video) : undefined;
            return !videoNode?.metadata?.content && (!videoNode || !activeNodeIds.has(videoNode.id));
        });
        if (!targetRows.length) { message.info("所选镜头视频已生成或正在生成"); return; }
        if (!options?.skipConfirmation && !await confirmGenerationSubmission(targetRows.length, videoModel, "视频生成")) return;
        createScriptVideoNodes(nodeId, true, targetRows.map((row) => row.id));
        scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        if (!scriptNode) return;
        const currentScriptNode = scriptNode;
        const videoSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
        const currentRows = targetRows.map((row) => currentScriptNode.metadata?.storyboard?.rows.find((item) => item.id === row.id) || row);
        // 生成时真正读的是节点 metadata.size / vquality（见 buildGenerationConfig）；
        // 不显式写入就会回落到全局默认，历史上出现过“界面要 16:9、上游收到 9:16”。
        const videoSize = submissionConfig.size || defaultConfig.size;
        const videoQuality = submissionConfig.vquality || defaultConfig.vquality;
        const startX = Math.max(...currentRows.map((row) => nodesRef.current.find((node) => node.id === row.imageNodeId)?.position.x || currentScriptNode.position.x + currentScriptNode.width)) + videoSpec.width + 120;
        const nextNodes = [...nodesRef.current];
        let nextConnections = [...connectionsRef.current];
        const targets: Array<{ row: StoryboardRow; node: CanvasNodeData; prompt: string }> = [];
        currentRows.forEach((row, index) => {
            const prompt = storyboardVideoPrompt(row);
            const existing = row.videoNodeId ? nextNodes.find((node) => node.id === row.videoNodeId && node.type === CanvasNodeType.Video) : undefined;
            const referenceIds = storyboardRowReferenceNodeIds(currentScriptNode, row, nextNodes, nextConnections, true, existing?.id);
            const composerContent = storyboardComposerContent(prompt, referenceIds, nextNodes);
            const existingMetadata = existing?.metadata?.content ? existing.metadata : resetGenerationTaskMetadata(existing?.metadata);
            const candidateVideoNode = existing
                ? { ...existing, metadata: { ...existingMetadata, prompt, composerContent, model: existingMetadata.model || videoModel, ...storyboardPromptTemplateMetadata(row, "video"), workflowKind: "shot" as const, workflowTitle: `镜头 ${row.shotNumber} 视频`, shotIndex: row.shotNumber, generationMode: "video" as const, videoEditOperation: "image_to_video" as const, videoStartFrameNodeId: row.imageNodeId, seconds: String(row.durationSeconds), size: existingMetadata.size || videoSize, vquality: existingMetadata.vquality || videoQuality } }
                : createCanvasNode(CanvasNodeType.Video, { x: startX, y: currentScriptNode.position.y + index * (videoSpec.height + 36) + videoSpec.height / 2 }, { prompt, composerContent, model: videoModel, ...storyboardPromptTemplateMetadata(row, "video"), workflowKind: "shot", workflowTitle: `镜头 ${row.shotNumber} 视频`, shotIndex: row.shotNumber, generationMode: "video", videoEditOperation: "image_to_video", videoStartFrameNodeId: row.imageNodeId, status: NODE_STATUS_IDLE, seconds: String(row.durationSeconds), size: videoSize, vquality: videoQuality });
            const videoNode = pinCanvasVideoGenerationConfig(submissionConfig, candidateVideoNode);
            if (!existing) {
                videoNode.title = `镜头 ${row.shotNumber} · 视频`;
                nextNodes.push(videoNode);
            } else {
                const existingIndex = nextNodes.findIndex((node) => node.id === existing.id);
                nextNodes[existingIndex] = videoNode;
            }
            nextConnections = reconcileStoryboardTargetConnections(nextConnections, currentScriptNode, row, videoNode.id, referenceIds);
            targets.push({ row, node: videoNode, prompt });
        });
        nodesRef.current = nextNodes;
        connectionsRef.current = nextConnections;
        setNodes(nextNodes);
        setConnections(nextConnections);
        const batchId = enqueueGenerationBatch(nodeId, "storyboard_video", targets.map((target) => ({ rowId: target.row.id, nodeId: target.node.id })), options?.clientOperationId ? { clientOperationId: options.clientOperationId } : undefined);
        if (batchId) message.success("镜头视频已加入生成队列");
        return batchId;
    }, [connectionsRef, confirmGenerationSubmission, createScriptVideoNodes, effectiveConfig, enqueueGenerationBatch, isAiConfigReady, message, nodesRef, setConnections, setNodes]);

    const agentGenerateScriptMedia = useCallback(async (input: CanvasAgentStoryboardMediaGenerationInput, beforeCommit: () => Promise<void>): Promise<CanvasAgentStoryboardMediaGenerationResult> => {
        const operationId = typeof input.clientOperationId === "string" ? input.clientOperationId.trim() : "";
        if (!operationId || operationId.length > 96) throw new Error("clientOperationId 必须是 1 至 96 字符的稳定标识");
        await beforeCommit();
        const preflight = agentPreflightScriptMedia(input);
        const scriptNode = nodesRef.current.find((node) => node.id === input.nodeId && node.type === CanvasNodeType.Script)!;
        const rowById = new Map((scriptNode.metadata?.storyboard?.rows || []).map((row) => [row.id, row]));
        const videoUsesKeyframe = input.kind === "video" && scriptNode.metadata?.storyboardVideoInputMode === "keyframe";
        const rows = preflight.rows.map((item) => {
            if (item.status !== "ready" || !videoUsesKeyframe) return item;
            const row = rowById.get(item.rowId)!;
            const image = row.imageNodeId ? nodesRef.current.find((node) => node.id === row.imageNodeId && node.type === CanvasNodeType.Image) : undefined;
            return image?.metadata?.content ? item : { ...item, status: "blocked" as const, reason: "关键帧视频需要已生成的首帧图片" };
        });
        const mode: CanvasGenerationBatchMode = input.kind === "image" ? "storyboard_image" : "storyboard_video";
        const previousBatch = scriptNode.metadata?.generationBatches?.find((batch) => batch.clientOperationId === operationId);
        if (previousBatch) {
            if (previousBatch.mode !== mode) throw new Error("相同 clientOperationId 已用于另一类分镜媒体生成");
            const requestedRows = new Set(input.rowIds);
            if (previousBatch.items.some((item) => !requestedRows.has(item.rowId)) || rows.some((row) => row.status === "ready" && !previousBatch.items.some((item) => item.rowId === row.rowId))) {
                throw new Error("相同 clientOperationId 已绑定不同 rowIds；拒绝重放或再次收费");
            }
            const targets = previousBatch.items.map((item) => ({ rowId: item.rowId, nodeId: item.nodeId }));
            const batchId = enqueueGenerationBatch(input.nodeId, mode, targets, { clientOperationId: operationId });
            if (!batchId) throw new Error("无法用相同 clientOperationId 恢复原分镜批次");
            const itemByRowId = new Map(previousBatch.items.map((item) => [item.rowId, item]));
            const currentByRowId = new Map(rows.map((row) => [row.rowId, row]));
            const recoveredRows = input.rowIds.map((rowId) => {
                const item = itemByRowId.get(rowId);
                const current = currentByRowId.get(rowId);
                if (item) return { rowId, nodeId: item.nodeId, ...(item.taskId ? { taskId: item.taskId } : {}), ...(item.clientOperationId ? { clientOperationId: item.clientOperationId } : {}), status: item.submissionUncertain ? "uncertain" as const : item.status, prompt: rowById.get(rowId)?.imageGenerationPrompt || rowById.get(rowId)?.videoMotionPrompt || "", assetNodeIds: current?.assetNodeIds || [], ...(item.errorDetails ? { reason: item.errorDetails } : {}) };
                if (current) return { ...current };
                throw new Error(`无法恢复分镜行状态：${rowId}`);
            });
            const previousStatus = previousBatch.status === "partial_failed" ? "partial" : previousBatch.status;
            return { nodeId: input.nodeId, kind: input.kind, clientOperationId: operationId, batchId, status: recoveredRows.some((row) => row.status === "uncertain") ? "uncertain" : previousStatus, submitted: true, rows: recoveredRows };
        }
        const readyRows = rows.filter((row) => row.status === "ready");
        if (!readyRows.length) return { nodeId: input.nodeId, kind: input.kind, clientOperationId: operationId, status: rows.some((row) => row.status === "running") ? "running" : rows.some((row) => row.status === "completed") ? "completed" : "blocked", submitted: false, rows };
        if (!await confirmGenerationSubmission(readyRows.length, preflight.model, input.kind === "image" ? "图片生成" : "视频生成")) {
            return { nodeId: input.nodeId, kind: input.kind, clientOperationId: operationId, status: "cancelled", submitted: false, rows };
        }
        await beforeCommit();
        const selectedRowIds = readyRows.map((row) => row.rowId);
        const batchId = input.kind === "image"
            ? await generateScriptImages(input.nodeId, selectedRowIds, { skipConfirmation: true, clientOperationId: operationId })
            : videoUsesKeyframe
                ? await generateScriptVideos(input.nodeId, selectedRowIds, { skipConfirmation: true, clientOperationId: operationId })
                : await createAndGenerateScriptVideos(input.nodeId, selectedRowIds, { skipConfirmation: true, clientOperationId: operationId });
        if (!batchId) throw new Error("分镜生成批次未能创建；未返回 batchId，请读取画布后用相同 clientOperationId 恢复");
        const currentScript = nodesRef.current.find((node) => node.id === input.nodeId && node.type === CanvasNodeType.Script);
        const currentRows = new Map((currentScript?.metadata?.storyboard?.rows || []).map((row) => [row.id, row]));
        const batch = currentScript?.metadata?.generationBatches?.find((item) => item.id === batchId);
        const batchItems = new Map(batch?.items.map((item) => [item.rowId, item]) || []);
        const resultRows = rows.map((row) => {
            const currentRow = currentRows.get(row.rowId);
            const mediaNodeId = input.kind === "image" ? currentRow?.imageNodeId : currentRow?.videoNodeId;
            const mediaNode = mediaNodeId ? nodesRef.current.find((node) => node.id === mediaNodeId) : undefined;
            const batchItem = batchItems.get(row.rowId);
            const taskId = mediaNode?.metadata?.taskId || batchItem?.taskId;
            const status = row.status === "ready" ? batchItem?.submissionUncertain ? "uncertain" as const : batchItem?.status || "waiting" as const : row.status;
            return { rowId: row.rowId, ...(mediaNodeId ? { nodeId: mediaNodeId } : {}), ...(taskId ? { taskId } : {}), ...(batchItem?.clientOperationId ? { clientOperationId: batchItem.clientOperationId } : {}), status, prompt: row.prompt, assetNodeIds: row.assetNodeIds, ...(row.reason ? { reason: row.reason } : {}) };
        });
        return { nodeId: input.nodeId, kind: input.kind, clientOperationId: operationId, batchId, status: resultRows.some((row) => row.status === "uncertain") ? "uncertain" : resultRows.some((row) => row.status === "blocked") ? "partial" : "queued", submitted: true, confirmation: { method: "native-generation-confirmation", model: preflight.model, taskCount: readyRows.length, confirmed: true }, rows: resultRows };
    }, [agentPreflightScriptMedia, confirmGenerationSubmission, createAndGenerateScriptVideos, enqueueGenerationBatch, generateScriptImages, generateScriptVideos, nodesRef]);

    return {
        agentStoryboardNodeOperations,
        agentGenerateScriptRows,
        agentPreflightScriptMedia,
        agentGenerateScriptMedia,
        addScriptRow,
        createAndGenerateScriptVideos,
        createScriptActionBoards,
        createScriptImageNodes,
        createScriptVideoNodes,
        generateScriptImages,
        generateScriptRows,
        generateScriptVideos,
        removeScriptRow,
        replaceScriptRows,
        updateScriptRow,
        updateScriptRows,
    };
}

function invalidateEditedPromptVariables(previous: StoryboardRow | undefined, next: StoryboardRow) {
    if (!previous) return next;
    return {
        ...next,
        imagePromptTemplateVariables: next.imageGenerationPrompt === previous.imageGenerationPrompt ? next.imagePromptTemplateVariables : undefined,
        videoPromptTemplateVariables: next.videoMotionPrompt === previous.videoMotionPrompt ? next.videoPromptTemplateVariables : undefined,
    };
}

function activeGenerationBatchNodeIds(node: CanvasNodeData, mode: CanvasGenerationBatchMode) {
    return new Set((node.metadata?.generationBatches || [])
        .filter((batch) => batch.mode === mode)
        .flatMap((batch) => batch.items
            .filter((item) => item.status === "waiting" || item.status === "submitting" || item.status === "queued" || item.status === "running")
            .map((item) => item.nodeId)));
}
