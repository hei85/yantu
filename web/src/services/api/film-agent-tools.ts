// 影视流水线工具：把衍图「已有的」生成任务与提示词模板能力直接交给 Codex 调度。
//
// 设计原则：这里不实现任何影视能力本身，只做三件事——
//   1. 列出服务端已经定义的 Prompt Operation（短剧大纲、资产提取、分镜规划……）；
//   2. 用页面同款调用方式（占位提示词 + promptTemplateOperation + 变量）发起生成任务；
//   3. 等待/查询已有任务，避免重复提交。
// 模板渲染、任务生命周期与产物登记全部复用现有后端与页面服务。

import { promptTemplateTaskPlaceholder } from "@/lib/prompts";
import { defaultAudioCapabilityConfig, modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { modelCompatibilityError, modelRequestOptions, type ModelRequirements } from "@/lib/model-selection";
import { normalizeFamily, videoModelMatchesFamily } from "@/lib/video-model-family";
import { videoDialogueObservation } from "@/lib/video-dialogue-observations";
import { effectiveConfigForCustomChannels, modelOptionName, normalizeModelOptionValue, resolveModelChannel, selectableModelsByCapability, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasGenerationMode } from "@/types/canvas";
import { listAdminPromptTemplates, type PromptTemplate, type PromptOperationDefinition } from "./auth";
import { parseBackendGenerationResult, submitBackendGenerationTask } from "./generation-task";
import { ApiError } from "./request";
import { queryGenerationTask, type GenerationTask } from "./task-center";
import { productionRuns, type ProductionDeliveryVerificationRequest, type ProductionStepInput, type ProductionStepResultRequest, type ProductionTaskRequest } from "./production-runs";
import { buildFilmProductionPlan, hydrateProductionVoiceBindings, type FilmProductionPlanSpec, type ProductionCharacterVoiceSource } from "./production-plan";
import { bindProductionTaskCanvasContext } from "@/lib/canvas/canvas-production-task-binding";
import { getProject } from "./projects";
import { probeResource, type ResourceProbeReport } from "./resources";
import { listAdminChannelModels, updateAdminChannelModel, type ChannelModel } from "./channel-models";
import { createTimelineRenderTask, type TimelineRenderOutput } from "./timeline-tasks";
import type { TimelineProject } from "@/types/timeline";
import type { CanvasNodeData, StoryboardRow, StoryboardSegmentBinding } from "@/types/canvas";
import { getPreparedFilmSkillEvidence } from "./agent-runtime-tools";
import { syncPortableLocalChannels } from "./portable-channel-sync";

export const filmAgentToolNames = [
    "film_list_operations",
    "film_list_models",
    "film_sync_local_models",
    "film_validate_strategy",
    "film_create_run",
    "film_get_run",
    "film_update_plan",
    "film_pause_run",
    "film_resume_run",
    "film_cancel_run",
    "film_submit_step",
    "film_probe_media",
    "film_record_model_outputs",
    "film_check_shot",
    "film_record_step_result",
    "film_render_timeline",
    "film_verify_delivery",
    "film_run_operation",
    "film_get_tasks",
    "film_wait_task",
] as const;

export type FilmAgentToolName = (typeof filmAgentToolNames)[number];

export function isFilmAgentToolName(value: string): value is FilmAgentToolName {
    return filmAgentToolNames.includes(value as FilmAgentToolName);
}

export function isFilmAgentReadTool(value: string) {
    return value === "film_list_operations" || value === "film_list_models" || value === "film_validate_strategy" || value === "film_get_run" || value === "film_get_tasks" || value === "film_probe_media" || value === "film_check_shot";
}

// Prompt Operation 只产出可审阅文本/JSON；图片、视频和音频的付费媒体生成只能走 canvas_generate_* 或后续 film_submit_step。
const terminalTaskStatuses = new Set(["succeeded", "failed", "cancelled"]);
const maxFilmTaskBatchSize = 20;
const filmTaskQueryConcurrency = 5;
const filmTaskQueryTimeoutMs = 15_000;
const maxFilmTaskWaitMs = 10_000;
const maxFilmTaskBridgeWaitMs = 25_000;
const shotDurationUndershootToleranceMs = 300;
const shotDurationOvershootToleranceMs = 999;
type FilmTaskQueryError = {
    name: string;
    message: string;
    status?: number;
    code?: number;
    reason?: string;
    retryable: boolean;
    retryAfterMs?: number;
};
type FilmTaskSnapshot = Omit<Partial<GenerationTask>, "status"> & Pick<GenerationTask, "id"> & {
    status?: string;
    queryError?: FilmTaskQueryError;
};

export async function runFilmAgentTool(name: FilmAgentToolName, rawInput: Record<string, unknown>, context?: { canvasNodes?: CanvasNodeData[] }) {
    if (name === "film_list_operations") return listFilmOperations();
    if (name === "film_list_models") return listFilmModels(rawInput);
    if (name === "film_sync_local_models") return syncPortableLocalChannels(currentEffectiveConfig());
    if (name === "film_validate_strategy") return validateFilmStrategy(rawInput);
    if (name === "film_create_run") return createFilmRun(rawInput, context?.canvasNodes);
    if (name === "film_get_run") return getFilmRun(rawInput);
    if (name === "film_update_plan") return updateFilmPlan(rawInput, context?.canvasNodes);
    if (name === "film_pause_run") return changeFilmRun(rawInput, "pause");
    if (name === "film_resume_run") return changeFilmRun(rawInput, "resume");
    if (name === "film_cancel_run") return changeFilmRun(rawInput, "cancel");
    if (name === "film_submit_step") return submitFilmStep(rawInput, context?.canvasNodes);
    if (name === "film_probe_media") return probeFilmMedia(rawInput);
    if (name === "film_record_model_outputs") return recordFilmModelOutputs(rawInput);
    if (name === "film_check_shot") return checkFilmShot(rawInput);
    if (name === "film_record_step_result") return recordFilmStepResult(rawInput);
    if (name === "film_render_timeline") return renderFilmTimeline(rawInput);
    if (name === "film_verify_delivery") return verifyFilmDelivery(rawInput);
    if (name === "film_run_operation") return runFilmOperation(rawInput);
    if (name === "film_get_tasks") return getFilmTasks(rawInput);
    if (name === "film_wait_task") return waitFilmTask(rawInput);
    throw new Error(`未知影视工具：${name}`);
}

async function listFilmOperations() {
    const { definitions, templates } = await listAdminPromptTemplates();
    const activeByOperation = new Map<string, PromptTemplate>();
    for (const template of templates) {
        if (template.enabled) activeByOperation.set(template.operation, template);
    }
    return {
        operations: definitions.map((definition) => summarizeDefinition(definition, activeByOperation.get(definition.operation))),
        guidance: [
            "多镜头任务优先用 project_create_or_update_shots 写入真实 Script 分镜，不要用普通文本节点堆 Markdown。",
            "章节只做一次 chapter_assets_extract；角色资产确认后再做 character_turnaround。",
            "storyboard_plan 产出后用 storyboard_repair 修结构，再逐镜 storyboard_first_frame / storyboard_video。",
            "同一镜头重试时必须复用同一个 clientOperationId，避免重复提交与重复任务。",
        ],
    };
}

function summarizeDefinition(definition: PromptOperationDefinition, active?: PromptTemplate) {
    return {
        operation: definition.operation,
        label: definition.label,
        category: definition.category,
        outputType: definition.outputType,
        description: definition.description,
        mode: "text",
        variables: (definition.variables || []).map((variable) => variable.placeholder || variable.label),
        activeTemplate: active ? { id: active.id, version: active.version, updatedAt: active.updatedAt } : null,
    };
}

async function runFilmOperation(rawInput: Record<string, unknown>) {
    const operation = String(rawInput.operation || "").trim();
    if (!operation) throw new Error("缺少 operation：请先用 film_list_operations 查看可用的影视操作");
    const variables = normalizeVariables(rawInput.variables);
    const requestedMode = normalizeMode(rawInput.mode);
    if (requestedMode && requestedMode !== "text") throw new Error("film_run_operation 只执行文本规划；图片、视频和音频生成必须走持久化制作步骤 film_submit_step");
    const mode: CanvasGenerationMode = "text";
    const config = currentEffectiveConfig();
    const preferredModel = resolveModelForMode(config, mode, rawInput.model);
    if (!preferredModel) throw new Error(`当前没有可用的${modeLabel(mode)}模型，请先在设置 → 模型渠道中配置`);
    const requirements = buildModelRequirements(config, mode, rawInput);
    const explicitModel = Boolean(optionalString(rawInput.model));
    const incompatibility = modelCompatibilityError(config, preferredModel, requirements);
    if (explicitModel && incompatibility) throw new Error(`用户指定的${modeLabel(mode)}模型 ${preferredModel} 不满足当前任务：${incompatibility}`);
    // 自动选择只作用于默认模型；用户明确指定的模型始终锁定，不静默换档。
    const model = explicitModel ? preferredModel : filmCompatibleModels(config, mode, requirements, preferredModel)[0] || "";
    if (!model || !hasVersionedCapability(config, model)) {
        throw new Error(`没有可提交的${modeLabel(mode)}模型能力版本；请先调用 film_list_models 查看阻断原因，再用 film_sync_local_models 登记本地渠道`);
    }
    const modelSelection = { requested: preferredModel, resolved: model, switched: model !== preferredModel };
    const clientOperationId = optionalString(rawInput.clientOperationId);
    if (!clientOperationId) throw new Error("缺少 clientOperationId：提交文本任务前必须生成并在不确定重试时复用同一 ID");
    const label = await operationLabel(operation);
    const options = {
        projectId: optionalString(rawInput.projectId),
        mode,
        prompt: promptTemplateTaskPlaceholder(label),
        config: { ...config, model },
        metadata: {
            source: "codex-agent",
            promptTemplateOperation: operation,
            promptTemplateVariables: variables,
        },
        clientOperationId,
        signal: AbortSignal.timeout(20_000),
    } satisfies Parameters<typeof submitBackendGenerationTask>[0];

    // The bridge only waits for durable task acceptance; model execution is polled by taskId.
    const task = await submitBackendGenerationTask(options);
    return {
        submitted: true,
        taskId: task.id,
        status: task.status,
        mode,
        operation,
        model: modelSelection,
        variables: Object.keys(variables),
        clientOperationId,
        nextAction: "film_wait_task",
        hint: "任务已持久化；请使用 taskId 查询进度。提交超时或页面断开时先用同一 clientOperationId 查询，不要换 ID 重发。",
    };
}

async function waitFilmTask(rawInput: Record<string, unknown>) {
    const taskId = String(rawInput.taskId || "").trim();
    if (!taskId) throw new Error("缺少 taskId");
    const timeoutMs = clampNumber(rawInput.timeoutMs, 1_000, 20_000, 10_000);
    const pollMs = clampNumber(rawInput.pollMs, 500, 10_000, 2_000);
    const deadline = Date.now() + timeoutMs;
    const query = () => queryFilmTasks([taskId], queryGenerationTask, Math.max(1, Math.min(filmTaskQueryTimeoutMs, deadline - Date.now())));
    let task = (await query())[0];

    while (!task.queryError && !terminalTaskStatuses.has(String(task.status)) && Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await delay(Math.min(taskPollDelayMs(task, pollMs), remainingMs));
        if (Date.now() >= deadline) break;
        task = (await query())[0];
    }

    const queryFailed = Boolean(task.queryError);
    const timedOut = !queryFailed && !terminalTaskStatuses.has(String(task.status));
    const nextPollAt = taskNextPollAt(task);
    return {
        taskId,
        model: task.model || "",
        capabilityRevision: task.capabilityRevision || "",
        status: task.status,
        timedOut,
        queryFailed,
        progress: task.progress,
        stage: task.pollStage || task.stage,
        error: task.error || "",
        errorCode: task.errorCode || "",
        queryError: task.queryError || null,
        retryable: task.queryError?.retryable ?? false,
        retryAfterMs: task.queryError ? task.queryError.retryAfterMs ?? (task.queryError.retryable ? 3000 : null) : retryDelayUntil(nextPollAt),
        nextPollAt,
        result: !queryFailed && !timedOut && terminalTaskStatuses.has(String(task.status)) ? optionalFilmTaskResult(task as GenerationTask) : undefined,
        hint: queryFailed
            ? "任务状态读取失败；按 queryError 的 retryAfterMs/nextPollAt 再查询同一 taskId，不要重新提交生成。"
            : timedOut ? "任务仍在进行：按 nextPollAt 稍后查询同一 taskId，不要重复提交同一镜头。" : "",
    };
}

async function validateFilmStrategy(rawInput: Record<string, unknown>) {
    const capability = normalizeMode(rawInput.capability);
    if (!capability) throw new Error("缺少 capability");
    const config = currentEffectiveConfig();
    const requested = legalModelValue(config, rawInput.model) || resolveModeDefault(config, capability);
    if (!requested) return { ok: false, code: "model_unavailable", capability, errors: [`当前没有可用的${modeLabel(capability)}模型`] };
    const requirements = buildModelRequirements(config, capability, rawInput);
    const explicitModel = Boolean(optionalString(rawInput.model));
    const videoModelFamily = capability === "video" ? requestedVideoModelFamily(rawInput) : "";
    const familyError = videoModelFamily && !videoModelMatchesFamily(requested, videoModelFamily)
        ? `模型 ${requested} 不属于指定的 ${videoModelFamily} 系列` : "";
    const compatibilityError = familyError || modelCompatibilityError(config, requested, requirements);
    const requestedError = compatibilityError || (explicitModel && !hasVersionedCapability(config, requested)
        ? `模型 ${requested} 未登记服务端能力版本，不能提交持久制作任务；请先同步模型目录`
        : "");
    const recommended = explicitModel
        ? requestedError ? "" : requested
        : filmCompatibleModels(config, capability, requirements, requested, true, videoModelFamily, audioOutputRequired(rawInput))[0] || "";
    const error = explicitModel ? requestedError : recommended ? modelCompatibilityError(config, recommended, requirements) : "没有兼容且已登记服务端能力版本的候选模型";
    return {
        ok: !error,
        capability,
        requested,
        recommended: recommended || "",
        switched: !explicitModel && Boolean(recommended && recommended !== requested),
        explicit: explicitModel,
        requestedCompatible: !requestedError,
        requestedError: requestedError || "",
        errors: error ? [error] : [],
        requirements,
        videoModelFamily,
        audioOutputRequired: capability === "video" && audioOutputRequired(rawInput),
        audioOutputEvidence: capability === "video" ? describeModel(config, recommended || requested, capability).supports.audioCapabilities : undefined,
        profile: describeModel(config, recommended || requested, capability).supports,
        actions: error
            ? explicitModel ? ["调整当前输入以适配指定模型", "或由用户重新指定模型"]
                : ["查询 compatible 候选并更新计划", "补齐必需前置资产", "或由用户调整硬约束"]
            : [],
    };
}

export async function getFilmTasks(
    rawInput: Record<string, unknown>,
    query: (taskId: string, options?: { signal?: AbortSignal }) => Promise<FilmTaskSnapshot> = queryGenerationTask,
) {
    const taskIds = Array.isArray(rawInput.taskIds)
        ? [...new Set(rawInput.taskIds.map((value) => String(value || "").trim()).filter(Boolean))]
        : [];
    if (!taskIds.length) throw new Error("缺少 taskIds");
    if (taskIds.length > maxFilmTaskBatchSize) throw new Error(`一次最多查询 ${maxFilmTaskBatchSize} 个任务；请分批查询`);
    const waitMs = clampNumber(rawInput.waitMs, 0, maxFilmTaskWaitMs, 0);
    const deadline = Date.now() + Math.min(maxFilmTaskBridgeWaitMs, filmTaskQueryTimeoutMs + waitMs);
    const poll = () => queryFilmTasks(taskIds, query, Math.max(1, Math.min(filmTaskQueryTimeoutMs, deadline - Date.now())));
    let tasks = await poll();
    while (waitMs > 0 && tasks.some(taskNeedsPolling) && Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const nextDelayMs = Math.min(...tasks.filter(taskNeedsPolling).map((task) => taskPollDelayMs(task, 1_500)));
        await delay(Math.min(nextDelayMs, remainingMs));
        if (Date.now() >= deadline) break;
        tasks = await poll();
    }
    return {
        tasks: tasks.map((task) => {
            const nextPollAt = taskNextPollAt(task);
            return {
                taskId: task.id,
                model: task.model || "",
                capabilityRevision: task.capabilityRevision || "",
                status: task.status,
                progress: task.progress,
                stage: task.pollStage || task.stage,
                error: task.error || "",
                errorCode: task.errorCode || "",
                queryError: task.queryError || null,
                retryable: task.queryError?.retryable ?? false,
                retryAfterMs: task.queryError ? task.queryError.retryAfterMs ?? (task.queryError.retryable ? 3000 : null) : retryDelayUntil(nextPollAt),
                terminal: terminalTaskStatuses.has(String(task.status)),
                nextPollAt,
                result: terminalTaskStatuses.has(String(task.status)) && task.type ? optionalFilmTaskResult(task as GenerationTask) : undefined,
            };
        }),
        hint: "每次最多查询 20 个任务；查询错误会单独返回结构化 queryError。按 nextPollAt/retryAfterMs 重查原 taskId，不要重新提交生成；客户端等待超时不取消上游任务。",
    };
}

/**
 * 终态任务不一定带 resultJson：失败/取消就是没有产物，缺产物不该让整个批量查询报错。
 * 只在真实存在结果时解析，其余返回 undefined，由调用方按 status/error/errorCode 判断。
 */
function optionalFilmTaskResult(task: GenerationTask) {
    return task.resultJson ? parseBackendGenerationResult(task) : undefined;
}

function taskNeedsPolling(task: FilmTaskSnapshot) {
    const status = String(task.status);
    return !terminalTaskStatuses.has(status) && !(status === "unknown" && task.error);
}

export async function queryFilmTasks(
    taskIds: string[],
    query: (taskId: string, options?: { signal?: AbortSignal }) => Promise<FilmTaskSnapshot> = queryGenerationTask,
    timeoutMs = filmTaskQueryTimeoutMs,
) {
    if (taskIds.length > maxFilmTaskBatchSize) throw new Error(`一次最多查询 ${maxFilmTaskBatchSize} 个任务；请分批查询`);
    const output = new Array<FilmTaskSnapshot>(taskIds.length);
    const signal = AbortSignal.timeout(Math.max(1, Math.min(filmTaskQueryTimeoutMs, timeoutMs)));
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < taskIds.length) {
            const index = nextIndex++;
            const taskId = taskIds[index];
            if (!taskId) continue;
            try {
                output[index] = await query(taskId, { signal });
            } catch (error) {
                const queryError = filmTaskQueryFailure(error, signal.aborted);
                output[index] = {
                    id: taskId,
                    status: "unknown",
                    progress: 0,
                    stage: "无法读取",
                    error: queryError.message,
                    queryError,
                };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(filmTaskQueryConcurrency, taskIds.length) }, worker));
    return output;
}

function filmTaskQueryFailure(error: unknown, timedOut: boolean): FilmTaskQueryError {
    if (error instanceof ApiError) {
        return {
            name: "ApiError",
            message: error.message,
            status: error.status,
            code: error.code,
            reason: error.reason,
            retryable: error.retryable,
            retryAfterMs: error.retryAfterMs,
        };
    }
    if (timedOut) return { name: "TimeoutError", message: "任务状态查询超时", retryable: true, retryAfterMs: 3000 };
    if (error instanceof DOMException && error.name === "AbortError") {
        return { name: "AbortError", message: "任务状态查询已取消", retryable: false };
    }
    return {
        name: error instanceof Error && error.name ? error.name : "Error",
        message: error instanceof Error ? error.message : "任务查询失败",
        retryable: false,
    };
}

function taskNextPollAt(task: FilmTaskSnapshot, now = Date.now()) {
    if (task.queryError) {
        if (!task.queryError.retryable) return null;
        return new Date(now + (task.queryError.retryAfterMs ?? 3000)).toISOString();
    }
    if (task.nextPollAt) return task.nextPollAt;
    return taskNeedsPolling(task) ? new Date(now + 3000).toISOString() : null;
}

function retryDelayUntil(nextPollAt: string | null) {
    if (!nextPollAt) return null;
    const next = Date.parse(nextPollAt);
    return Number.isFinite(next) ? Math.max(0, next - Date.now()) : null;
}

function taskPollDelayMs(task: FilmTaskSnapshot, fallbackMs: number) {
    const scheduled = Date.parse(task.nextPollAt || "");
    if (!Number.isFinite(scheduled)) return fallbackMs;
    return Math.max(500, scheduled - Date.now());
}
async function probeFilmMedia(rawInput: Record<string, unknown>) {
    const resourceId = String(rawInput.resourceId || "").trim();
    if (!resourceId) throw new Error("缺少 resourceId");
    const result = await probeResource(resourceId, rawInput.fullDecode === true);
    const ok = result.probe.videoStreams > 0 || result.probe.audioStreams > 0 || result.probe.streams.length > 0;
    return { ok, ...result, checkedAt: new Date().toISOString() };
}

async function recordFilmModelOutputs(rawInput: Record<string, unknown>) {
    const taskIds = Array.isArray(rawInput.taskIds) ? rawInput.taskIds.map(String).filter(Boolean) : [];
    if (!taskIds.length || taskIds.length > 4 || new Set(taskIds).size !== taskIds.length) {
        throw new Error("请提供 1 至 4 个不重复的成功视频 taskId");
    }
    const tasks = await Promise.all(taskIds.map((id) => queryGenerationTask(id)));
    const samples = await Promise.all(tasks.map(async (task) => {
        if (task.status !== "succeeded" || !task.model || !task.resultJson) throw new Error(`任务 ${task.id} 不是带产物的成功视频任务`);
        const result = parseBackendGenerationResult(task);
        const resourceId = result.video?.resourceId;
        if (result.mode !== "video" || !resourceId) throw new Error(`任务 ${task.id} 没有可核对的视频资源`);
        const media = await probeResource(resourceId, true);
        if (media.mediaType !== "video" || !media.probe.decoded || media.probe.videoStreams < 1) {
            throw new Error(`任务 ${task.id} 的视频不能完整解码`);
        }
        const inputEvidence = parseVideoTaskInputEvidence(task.inputJson);
        return {
            taskId: task.id, model: task.model, capabilityRevision: task.capabilityRevision || "", resourceId,
            audioStreams: media.probe.audioStreams, videoStreams: media.probe.videoStreams,
            width: media.probe.width, height: media.probe.height, durationMs: media.probe.durationMs,
            inputEvidence,
        };
    }));
    const config = currentEffectiveConfig();
    const channelModels = new Map<string, ChannelModel[]>();
    const recorded: Array<{ model: string; capabilityRevision: string; taskIds: string[]; nativeAudioSamples: number; silentSamples: number }> = [];
    for (const modelValue of [...new Set(samples.map((sample) => sample.model))]) {
        const group = samples.filter((sample) => sample.model === modelValue);
        const [channelId, modelKey] = modelValue.split("::");
        if (!channelId || !modelKey || !config.channels.some((channel) => channel.id === channelId)) {
            throw new Error(`任务模型 ${modelValue} 不属于当前已连接的模型渠道`);
        }
        if (!channelModels.has(channelId)) channelModels.set(channelId, (await listAdminChannelModels(channelId)).models);
        const model = channelModels.get(channelId)?.find((item) => item.modelKey === modelKey);
        if (!model || model.capability !== "video" || !model.capabilityConfig?.video) throw new Error(`当前渠道没有视频模型 ${modelValue} 的能力记录`);
        const existing = model.capabilityConfig.observed || [];
        const fresh = group.filter((sample) => !existing.some((item) => item.source === "media_probe" && item.reason?.includes(`taskId=${sample.taskId};`)));
        const revision = `${model.id}:${model.capabilityVersion}`;
        if (fresh.some((sample) => sample.capabilityRevision && sample.capabilityRevision !== revision)) {
            throw new Error(`任务使用的 ${modelValue} 能力版本已变化，不能把旧视频当成当前模型的能力证明`);
        }
        let saved = model;
        if (fresh.length) {
            const at = new Date().toISOString();
            const observed = [...existing, ...fresh.map((sample) => ({
                verdict: sample.audioStreams > 0 ? "supported" : "silent",
                feature: "native_audio_output", source: "media_probe", at,
                reason: `taskId=${sample.taskId}; resourceId=${sample.resourceId}; audioStreams=${sample.audioStreams}`,
            })), ...fresh.map((sample) => ({
                verdict: "observed", feature: "video_output_profile", source: "media_probe", at,
                reason: `taskId=${sample.taskId}; resourceId=${sample.resourceId}`,
                details: {
                    width: sample.width, height: sample.height, durationMs: sample.durationMs,
                    ...(sample.inputEvidence ? { inputCounts: sample.inputEvidence } : {}),
                },
            }))].slice(-12);
            const response = await updateAdminChannelModel(channelId, model.id, {
                modelKey: model.modelKey, providerModelKey: model.providerModelKey,
                displayName: model.displayName, channelLabel: model.channelLabel, description: model.description,
                icon: model.icon, capability: model.capability, protocol: model.protocol, enabled: model.enabled,
                capabilityConfig: { ...model.capabilityConfig, observed },
                variants: model.variants.map((variant) => ({ selector: variant.selector, resolution: variant.resolution, videoSeconds: variant.videoSeconds, providerModelKey: variant.providerModelKey, enabled: variant.enabled })),
            });
            // The PATCH response does not hydrate capabilityConfig; fetch the
            // saved model before refreshing the page-side catalog.
            saved = (await listAdminChannelModels(channelId)).models.find((item) => item.id === model.id) || response.model;
            if (!saved.capabilityConfig?.video) throw new Error(`模型 ${modelValue} 的实测证据已保存，但目录回读失败，请刷新画布后重查`);
            useConfigStore.setState((state) => ({ config: {
                ...state.config,
                channels: state.config.channels.map((channel) => channel.id !== channelId ? channel : {
                    ...channel,
                    modelCosts: channel.modelCosts?.map((cost) => cost.model !== modelKey ? cost : {
                        ...cost, capabilityConfig: saved.capabilityConfig, capabilityVersion: saved.capabilityVersion,
                    }),
                }),
            } }));
        }
        recorded.push({ model: modelValue, capabilityRevision: `${saved.id}:${saved.capabilityVersion}`, taskIds: group.map((sample) => sample.taskId), nativeAudioSamples: group.filter((sample) => sample.audioStreams > 0).length, silentSamples: group.filter((sample) => sample.audioStreams === 0).length });
    }
    return { recorded, samples, guidance: "这里只记录实际视频音轨样本，不改写生成声音开关；规划和交付时仍逐段探测音轨。" };
}

export function hasCompleteVideoFrameSamples(samples?: ResourceProbeReport["probe"]["videoFrameSamples"]) {
    const decodedPositions = new Set((samples || []).filter((sample) => sample.decoded && sample.imageBytes > 8).map((sample) => sample.position));
    return (["start", "middle", "end"] as const).every((position) => decodedPositions.has(position));
}

export function isShotDurationAcceptable(actualDurationMs: number, expectedDurationMs: number) {
    if (!Number.isFinite(actualDurationMs) || !Number.isFinite(expectedDurationMs) || actualDurationMs <= 0 || expectedDurationMs <= 0) return false;
    return actualDurationMs >= Math.max(0, expectedDurationMs - shotDurationUndershootToleranceMs)
        && actualDurationMs <= expectedDurationMs + shotDurationOvershootToleranceMs;
}

function shotDurationRange(expectedDurationMs: number) {
    return {
        min: Math.max(0, expectedDurationMs - shotDurationUndershootToleranceMs),
        max: expectedDurationMs + shotDurationOvershootToleranceMs,
    };
}

async function checkFilmShot(rawInput: Record<string, unknown>) {
    const result = await probeFilmMedia({ ...rawInput, fullDecode: rawInput.fullDecode !== false });
    const checks: Array<{ name: string; status: "passed" | "failed"; detail: string }> = [];
    if (rawInput.requireVideo === true) checks.push({ name: "video_stream", status: result.probe.videoStreams > 0 ? "passed" : "failed", detail: `${result.probe.videoStreams} video streams` });
    if (rawInput.requireAudio === true) checks.push({ name: "audio_stream", status: result.probe.audioStreams > 0 ? "passed" : "failed", detail: `${result.probe.audioStreams} audio streams` });
    if (result.probe.videoStreams > 0) {
        const samplesPassed = hasCompleteVideoFrameSamples(result.probe.videoFrameSamples);
        checks.push({ name: "video_frame_samples", status: samplesPassed ? "passed" : "failed", detail: samplesPassed ? "start/middle/end frames decoded" : "首、中、尾帧解码证据不完整" });
    }
    const expectedDurationMs = numberValue(rawInput.expectedDurationMs);
    if (expectedDurationMs !== undefined) {
        const range = shotDurationRange(expectedDurationMs);
        const passed = isShotDurationAcceptable(result.probe.durationMs, expectedDurationMs);
        checks.push({ name: "duration", status: passed ? "passed" : "failed", detail: `actual=${result.probe.durationMs}ms expected=${expectedDurationMs}ms allowed=${range.min}..${range.max}ms; the next whole-second boundary is excluded` });
    }
    checks.push({ name: "full_decode", status: result.probe.decoded ? "passed" : "failed", detail: result.probe.decoded ? "decoded" : "full decode not verified" });
    return {
        status: checks.some((check) => check.status === "failed") ? "failed" : "passed",
        checks,
        media: result,
        semanticQuality: { status: "unavailable", reason: "没有接入独立语义检查模型或标注样本" },
    };
}

async function recordFilmStepResult(rawInput: Record<string, unknown>) {
    const runId = String(rawInput.runId || "").trim();
    const stepId = String(rawInput.stepId || "").trim();
    const expectedRevision = numberValue(rawInput.expectedRevision);
    const evidence = recordValue(rawInput.evidence);
    if (!runId || !stepId || expectedRevision === undefined || !evidence) {
        throw new Error("记录制作质检结果需要 runId、stepId、expectedRevision 和 evidence");
    }
    const input: ProductionStepResultRequest = { expectedRevision, stepId, evidence };
    return productionRuns.recordStepResult(runId, input);
}

async function renderFilmTimeline(rawInput: Record<string, unknown>) {
    const projectId = String(rawInput.projectId || "").trim();
    const timeline = recordValue(rawInput.timeline) as TimelineProject | undefined;
    if (!projectId || !timeline) throw new Error("缺少 projectId 或 timeline");
    const renderContext = productionRenderContext(rawInput);
    if (renderContext) {
        const result = await productionRuns.submitRenderStep(renderContext.runId, {
            expectedRevision: renderContext.expectedRevision,
            stepId: renderContext.stepId,
            idempotencyKey: renderContext.idempotencyKey,
            retryOf: rawInput.retryOf ? String(rawInput.retryOf) : undefined,
            timeline: { projectId, timeline, output: recordValue(rawInput.output) },
        });
        return { submitted: true, taskId: (result.task as { id?: string })?.id || "", status: "submitted", stepId: result.stepId, attempt: result.attempt, nextAction: "film_get_tasks", hint: "渲染已绑定到持久化制作步骤；使用短查询继续。" };
    }
    const task = await createTimelineRenderTask({ projectId, timeline, output: recordValue(rawInput.output) as TimelineRenderOutput | undefined });
    return { submitted: true, taskId: task.id, status: task.status, nextAction: "film_wait_task", hint: "渲染提交已返回；使用短查询继续，不要重复提交。" };
}

function productionRenderContext(rawInput: Record<string, unknown>) {
    const runId = String(rawInput.runId || "").trim();
    const stepId = String(rawInput.stepId || "").trim();
    const idempotencyKey = String(rawInput.idempotencyKey || "").trim();
    const expectedRevision = numberValue(rawInput.expectedRevision);
    const supplied = Boolean(runId || stepId || idempotencyKey || rawInput.retryOf || rawInput.expectedRevision !== undefined);
    if (!supplied) return undefined;
    if (!runId || !stepId || !idempotencyKey || idempotencyKey.length > 120 || expectedRevision === undefined) {
        throw new Error("ProductionRun 渲染必须同时提供 runId、stepId、idempotencyKey 和 expectedRevision，不能退化为普通时间线渲染");
    }
    return { runId, stepId, idempotencyKey, expectedRevision };
}

async function verifyFilmDelivery(rawInput: Record<string, unknown>) {
    const resourceId = String(rawInput.resourceId || "").trim();
    if (!resourceId) throw new Error("缺少 resourceId");
    const runId = String(rawInput.runId || "").trim();
    if (runId) {
        return productionRuns.verify(runId, buildFilmDeliveryVerificationRequest(rawInput));
    }
    const result = await probeResource(resourceId, true);
    const checks: Array<{ name: string; status: "passed" | "failed" | "uncertain"; detail: string }> = [];
    const requireVideo = rawInput.requireVideo !== false;
    const requireAudio = rawInput.requireAudio === true;
    checks.push({ name: "readable", status: "passed", detail: "resource opened and probed" });
    checks.push({ name: "non_empty", status: result.probe.fileSizeBytes > 0 ? "passed" : "failed", detail: `fileSizeBytes=${result.probe.fileSizeBytes}` });
    checks.push({ name: "full_decode", status: result.probe.decoded ? "passed" : "uncertain", detail: result.probe.decoded ? "decoded" : "decode report unavailable" });
    if (requireVideo) checks.push({ name: "video_stream", status: result.probe.videoStreams > 0 ? "passed" : "failed", detail: `${result.probe.videoStreams} video streams` });
    if (requireAudio) checks.push({ name: "audio_stream", status: result.probe.audioStreams > 0 ? "passed" : "failed", detail: `${result.probe.audioStreams} audio streams` });
    if (rawInput.requireSubtitle === true) checks.push({ name: "subtitle_stream", status: result.probe.subtitleStreams > 0 ? "passed" : "uncertain", detail: "字幕可能为外挂文件，不能仅凭容器流判断缺失" });
    const expectedDurationMs = numberValue(rawInput.expectedDurationMs);
    if (expectedDurationMs !== undefined) {
        const range = shotDurationRange(expectedDurationMs);
        const passed = isShotDurationAcceptable(result.probe.durationMs, expectedDurationMs);
        checks.push({ name: "duration", status: passed ? "passed" : "failed", detail: `actual=${result.probe.durationMs}ms expected=${expectedDurationMs}ms allowed=${range.min}..${range.max}ms; the next whole-second boundary is excluded` });
    }
    const expectedWidth = numberValue(rawInput.expectedWidth);
    const expectedHeight = numberValue(rawInput.expectedHeight);
    if (expectedWidth !== undefined && expectedHeight !== undefined) {
        const matches = result.probe.width === expectedWidth && result.probe.height === expectedHeight;
        checks.push({ name: "dimensions", status: matches ? "passed" : "failed", detail: `actual=${result.probe.width}x${result.probe.height} expected=${expectedWidth}x${expectedHeight}` });
    }
    const expectedAspectRatio = optionalString(rawInput.expectedAspectRatio);
    if (expectedAspectRatio) {
        const matches = aspectRatioWithinTolerance(result.probe.width, result.probe.height, expectedAspectRatio);
        checks.push({ name: "aspect_ratio", status: matches ? "passed" : "failed", detail: `actual=${result.probe.width}:${result.probe.height} expected=${expectedAspectRatio} tolerance=3%` });
    }
    checks.push({ name: "brief_contract", status: "uncertain", detail: "缺少 runId，无法对照持久化 Brief 时长、画幅与交付要求；不能标记为整片通过" });
    const deliveryStatus = checks.some((check) => check.status === "failed") ? "failed" : "uncertain";
    return {
        deliveryStatus,
        checks,
        media: result,
        completed: false,
        run: null,
    };
}

export function aspectRatioWithinTolerance(width: number, height: number, expectedAspectRatio: string, tolerance = 0.03): boolean {
    const parts = expectedAspectRatio.split(":").map(Number);
    const expected = parts.length === 2 && parts[0] > 0 && parts[1] > 0 ? parts[0] / parts[1] : 0;
    const actual = height > 0 ? width / height : 0;
    return expected > 0 && actual > 0 && Math.abs(actual - expected) / expected <= tolerance;
}

export function buildFilmDeliveryVerificationRequest(rawInput: Record<string, unknown>): ProductionDeliveryVerificationRequest {
    const expectedRevision = numberValue(rawInput.expectedRevision);
    const resourceId = String(rawInput.resourceId || "").trim();
    if (!resourceId) throw new Error("缺少 resourceId");
    if (expectedRevision === undefined) throw new Error("按 ProductionRun 验收必须提供 expectedRevision；请先读取 film_get_run");
    return {
        expectedRevision,
        resourceId,
        expectedDurationMs: numberValue(rawInput.expectedDurationMs),
        expectedAspectRatio: optionalString(rawInput.expectedAspectRatio),
        expectedWidth: numberValue(rawInput.expectedWidth),
        expectedHeight: numberValue(rawInput.expectedHeight),
        requireVideo: rawInput.requireVideo === true ? true : undefined,
        requireAudio: rawInput.requireAudio === true ? true : undefined,
        requireSubtitle: rawInput.requireSubtitle === true ? true : undefined,
    };
}
async function createFilmRun(rawInput: Record<string, unknown>, canvasNodes?: CanvasNodeData[]) {
    const policy = recordValue(rawInput.policy) || {};
    const videoModelFamily = normalizeFamily(optionalString(rawInput.videoModelFamily) || optionalString(policy.videoModelFamily) || "");
    if (rawInput.videoModelFamily && policy.videoModelFamily && normalizeFamily(String(rawInput.videoModelFamily)) !== normalizeFamily(String(policy.videoModelFamily))) {
        throw new Error("videoModelFamily 与 policy.videoModelFamily 不一致");
    }
    const planInput = hydrateProductionPlanFromCanvasStoryboard(recordValue(rawInput.plan) || {}, canvasNodes);
    const productionSpec = recordValue(planInput.productionSpec);
    if (Number(productionSpec?.workflowVersion) !== 2 || !recordValue(productionSpec?.preproduction)) {
        throw new Error("新建全片必须使用 productionSpec.workflowVersion=2，并提供完整 preproduction 产物引用；普通画布单节点生成不受此限制");
    }
    const planSpec = await buildProjectPlanFromSpec({ ...planInput, productionSpec: { ...productionSpec, selfCheckVersion: 1 } }, { ...rawInput, videoModelFamily });
    return productionRuns.create({
        clientKey: String(rawInput.clientKey || "").trim(),
        domainProjectId: optionalString(rawInput.domainProjectId),
        canvasId: optionalString(rawInput.canvasId),
        creationRunId: optionalString(rawInput.creationRunId),
        workflowInstanceId: optionalString(rawInput.workflowInstanceId),
        brief: recordValue(rawInput.brief),
        deliveryContract: recordValue(rawInput.deliveryContract),
        plan: planSpec.plan,
        policy: { ...policy, ...(videoModelFamily ? { videoModelFamily } : {}) },
        quality: recordValue(rawInput.quality),
        audioMode: String(recordValue(planSpec.plan.executionManifest)?.audioMode || rawInput.audioMode || "NATIVE_AUDIO") as "NATIVE_AUDIO" | "REBUILD_AUDIO",
        targetDurationMs: numberValue(rawInput.targetDurationMs),
        targetFpsNumerator: numberValue(rawInput.targetFpsNumerator),
        targetFpsDenominator: numberValue(rawInput.targetFpsDenominator),
        budgetLimit: numberValue(rawInput.budgetLimit),
        steps: planSpec.steps ?? (Array.isArray(rawInput.steps) ? rawInput.steps as ProductionStepInput[] : undefined),
    });
}

async function getFilmRun(rawInput: Record<string, unknown>) {
    return productionRuns.get(String(rawInput.runId || "").trim(), numberValue(rawInput.afterSequence));
}

async function updateFilmPlan(rawInput: Record<string, unknown>, canvasNodes?: CanvasNodeData[]) {
    const planInput = hydrateProductionPlanFromCanvasStoryboard(recordValue(rawInput.plan) || {}, canvasNodes);
    const run = await productionRuns.get(String(rawInput.runId || "").trim());
    const videoModelFamily = normalizeFamily(optionalString(run.policy?.videoModelFamily) || "");
    if (rawInput.videoModelFamily && normalizeFamily(String(rawInput.videoModelFamily)) !== videoModelFamily) {
        throw new Error("制作运行的模型系列限制不能通过更新计划改变；请新建制作运行");
    }
    // run 上固化的 Brief/交付合同是音轨与时长要求的来源；调用方没重传时要带上，否则计划预篩看不到合同要求。
    const brief = recordValue(rawInput.brief) || recordValue(run.brief);
    const deliveryContract = recordValue(rawInput.deliveryContract) || recordValue(run.deliveryContract);
    const planSpec = await buildProjectPlanFromSpec(planInput, {
        ...rawInput,
        // Plan changes inherit the persisted run's budget mode; caller-supplied
        // policy/spec flags cannot opt a bounded run into unknown pricing.
        policy: run.policy,
        videoModelFamily,
        brief,
        deliveryContract,
        domainProjectId: optionalString(rawInput.domainProjectId) || run.domainProjectId,
    });
    return productionRuns.updatePlan(String(rawInput.runId || "").trim(), {
        expectedRevision: numberValue(rawInput.expectedRevision) || 0,
        plan: planSpec.plan,
        steps: planSpec.steps ?? (Array.isArray(rawInput.steps) ? rawInput.steps as ProductionStepInput[] : undefined),
    });
}

export function hydrateProductionPlanFromCanvasStoryboard(plan: Record<string, unknown>, canvasNodes: CanvasNodeData[] = []) {
    const productionSpec = recordValue(plan.productionSpec);
    if (!productionSpec || !Array.isArray(productionSpec.storyboardRows) || canvasNodes.length === 0) return plan;

    const storyboardRowsById = new Map<string, StoryboardRow[]>();
    for (const node of canvasNodes) {
        if (node.type !== "script") continue;
        for (const sourceRow of node.metadata?.storyboard?.rows || []) {
            const rowId = String(sourceRow.id || "").trim();
            if (!rowId) continue;
            const matches = storyboardRowsById.get(rowId) || [];
            matches.push(sourceRow);
            storyboardRowsById.set(rowId, matches);
        }
    }

    const hydratedRows = productionSpec.storyboardRows.map((rawRow) => {
        const row = recordValue(rawRow);
        if (!row) return rawRow;
        const rowId = String(row.rowId || row.id || "").trim();
        if (!rowId) return rawRow;
        const matches = storyboardRowsById.get(rowId) || [];
        if (matches.length > 1) throw new Error(`ProductionSpec 分镜 ${rowId} 在当前画布有多个 Script 来源，不能猜测媒体绑定`);
        const sourceRow = matches[0];
        if (!sourceRow) return rawRow;

        const sourceBindings = sourceRow.segmentBindings || [];
        const sourceBySegment = new Map(sourceBindings.map((binding) => [binding.segmentId, binding]));
        const normalizedSourceBinding = (binding: StoryboardSegmentBinding) => ({
            segmentId: binding.segmentId,
            order: binding.order,
            videoNodeId: binding.videoNodeId,
            taskId: binding.taskId,
            resourceId: binding.resourceId,
            model: binding.model,
            capabilityRevision: binding.capabilityRevision,
            requestedDurationSeconds: binding.requestedDurationSeconds,
            timelineStartMs: binding.timelineStartMs,
            timelineDurationMs: binding.timelineDurationMs,
            status: binding.status,
        });
        const reusableBinding = (binding: ReturnType<typeof normalizedSourceBinding>) => binding.status === "succeeded"
            && Boolean(binding.videoNodeId?.trim())
            && Boolean(binding.resourceId?.trim());
        const existingMediaFor = (binding: ReturnType<typeof normalizedSourceBinding>) => ({
            resourceId: binding.resourceId!,
            ...(binding.taskId?.trim() ? { sourceTaskId: binding.taskId } : {}),
            sourceNodeId: binding.videoNodeId!,
        });

        const segments = Array.isArray(row.segments)
            ? row.segments.map((rawSegment) => {
                const segment = recordValue(rawSegment);
                if (!segment) return rawSegment;
                const segmentId = String(segment.segmentId || "").trim();
                const sourceBinding = segmentId ? sourceBySegment.get(segmentId) : undefined;
                if (!sourceBinding || !reusableBinding(normalizedSourceBinding(sourceBinding))) return rawSegment;
                const sourceMedia = existingMediaFor(normalizedSourceBinding(sourceBinding));
                const suppliedMedia = recordValue(segment.existingMedia);
                if (suppliedMedia) {
                    for (const [key, expected] of Object.entries(sourceMedia)) {
                        const supplied = String(suppliedMedia[key] || "").trim();
                        if (supplied && supplied !== expected) throw new Error(`ProductionSpec 分镜 ${rowId} 片段 ${segmentId} 的现有媒体与当前画布 SegmentBinding 不一致`);
                    }
                }
                return { ...segment, existingMedia: sourceMedia };
            })
            : undefined;

        const suppliedBindings = Array.isArray(row.segmentBindings) ? row.segmentBindings : [];
        const segmentBindings = suppliedBindings.length
            ? suppliedBindings.map((rawBinding) => {
                const binding = recordValue(rawBinding);
                if (!binding) return rawBinding;
                const segmentId = String(binding.segmentId || "").trim();
                const sourceBinding = segmentId ? sourceBySegment.get(segmentId) : undefined;
                if (!sourceBinding) return rawBinding;
                const authoritative = normalizedSourceBinding(sourceBinding);
                for (const key of ["videoNodeId", "taskId", "resourceId"] as const) {
                    const supplied = String(binding[key] || "").trim();
                    const actual = String(authoritative[key] || "").trim();
                    if (supplied && actual && supplied !== actual) throw new Error(`ProductionSpec 分镜 ${rowId} 片段 ${segmentId} 的追踪字段与当前画布 SegmentBinding 不一致`);
                }
                return { ...binding, ...authoritative };
            })
            : sourceBindings.map(normalizedSourceBinding);

        const sourceVideoNodeId = String(sourceRow.videoNodeId || "").trim();
        const requestedVideoNodeId = String(row.videoNodeId || "").trim();
        if (sourceVideoNodeId && requestedVideoNodeId && sourceVideoNodeId !== requestedVideoNodeId) {
            throw new Error(`ProductionSpec 分镜 ${rowId} 的 videoNodeId 与当前画布 Script 不一致`);
        }

        return {
            ...row,
            ...(sourceVideoNodeId && !requestedVideoNodeId ? { videoNodeId: sourceVideoNodeId } : {}),
            ...(segmentBindings.length ? { segmentBindings } : {}),
            ...(segments ? { segments } : {}),
        };
    });

    return { ...plan, productionSpec: { ...productionSpec, storyboardRows: hydratedRows } };
}

async function buildProjectPlanFromSpec(plan: Record<string, unknown>, rawInput: Record<string, unknown>) {
    if (!plan.productionSpec || typeof plan.productionSpec !== "object" || Array.isArray(plan.productionSpec)) return buildPlanFromSpec(plan, rawInput);
    const projectId = optionalString(rawInput.domainProjectId);
    if (!projectId) return buildPlanFromSpec(plan, rawInput);
    const detail = await getProject(projectId);
    const voiceSources: ProductionCharacterVoiceSource[] = detail.assets.flatMap((asset) => {
        if (asset.category !== "character") return [];
        const version = asset.character?.voice?.voiceVersion;
        const compatibleModels = asset.character?.voice?.profile.compatibleModels || [];
        return [{ characterId: asset.id, ...(compatibleModels.length ? { voiceProfile: { compatibleModels } } : {}), ...(version ? { voiceVersion: version } : {}) }];
    });
    const productionSpec = hydrateProductionVoiceBindings(recordValue(plan.productionSpec) as FilmProductionPlanSpec, voiceSources);
    return buildPlanFromSpec({ ...plan, productionSpec }, rawInput);
}

export function buildPlanFromSpec(plan: Record<string, unknown>, rawInput: Record<string, unknown>): { plan: Record<string, unknown>; steps?: ProductionStepInput[] } {
    if (!plan.productionSpec || typeof plan.productionSpec !== "object" || Array.isArray(plan.productionSpec)) return { plan };
    if (Array.isArray(rawInput.steps) && rawInput.steps.length > 0) throw new Error("ProductionPlan 有 productionSpec 时不能同时手工传 steps，避免两份计划不一致");
    const rawSpec = recordValue(plan.productionSpec) || {};
    const contract = recordValue(rawInput.deliveryContract) || {};
    const spec = {
        ...rawSpec,
        audioMode: optionalString(rawInput.audioMode) || optionalString(rawSpec.audioMode) || undefined,
        targetDurationMs: numberValue(rawSpec.targetDurationMs) ?? numberValue(contract.targetDurationMs) ?? numberValue(rawInput.targetDurationMs),
        targetFpsNumerator: numberValue(rawSpec.targetFpsNumerator) ?? numberValue(rawInput.targetFpsNumerator) ?? 30,
        targetFpsDenominator: numberValue(rawSpec.targetFpsDenominator) ?? numberValue(rawInput.targetFpsDenominator) ?? 1,
        targetAspectRatio: optionalString(rawSpec.targetAspectRatio) || optionalString(contract.targetAspectRatio) || "",
    } as FilmProductionPlanSpec;
    spec.allowUnknownPricing = String(recordValue(rawInput.policy)?.budgetPolicy || "").toLowerCase() === "unbounded";
    const currentConfig = currentEffectiveConfig();
    spec.selectedVideoModel = optionalString(rawSpec.selectedVideoModel)
        ? legalModelValue(currentConfig, rawSpec.selectedVideoModel)
        : undefined;
    spec.storyboardRows = Array.isArray(rawSpec.storyboardRows) ? rawSpec.storyboardRows.map((rowValue) => {
        const row = recordValue(rowValue);
        if (!row) return rowValue as FilmProductionPlanSpec["storyboardRows"][number];
        const rawSegments = Array.isArray(row.segments) ? row.segments : undefined;
        return {
            ...row,
            ...(optionalString(row.videoModel) ? { videoModel: legalModelValue(currentConfig, row.videoModel) } : {}),
            ...(rawSegments ? { segments: rawSegments.map((segmentValue) => {
                const segment = recordValue(segmentValue);
                return segment && optionalString(segment.model)
                    ? { ...segment, model: legalModelValue(currentConfig, segment.model) }
                    : segmentValue;
            }) } : {}),
        } as FilmProductionPlanSpec["storyboardRows"][number];
    }) : [];
    const videoModelFamily = normalizeFamily(optionalString(rawInput.videoModelFamily) || "");
    const liveVideoModels = new Map(selectableModelsByCapability(currentConfig, "video")
        .map((value) => [value, describeModel(currentConfig, value, "video")] as const));
    const suppliedVideoModels = Array.isArray(rawSpec.videoModels) ? rawSpec.videoModels : [];
    spec.videoModels = suppliedVideoModels.map((entry) => {
        const supplied = recordValue(entry);
        const value = legalModelValue(currentConfig, supplied?.value);
        const live = liveVideoModels.get(value);
        if (!live) throw new Error(`视频模型 ${value || "(空)"} 不在当前真实能力目录中，请重新读取 film_list_models`);
        const suppliedRevision = optionalString(recordValue(supplied?.supports)?.capabilityRevision);
        if (suppliedRevision && suppliedRevision !== live.supports.capabilityRevision) {
            throw new Error(`视频模型 ${value} 的能力版本已变化，请重新读取 film_list_models`);
        }
        return live;
    }).filter((model) => !videoModelFamily || videoModelMatchesFamily(model.value, videoModelFamily));
    if (videoModelFamily && ![...liveVideoModels.keys()].some((model) => videoModelMatchesFamily(model, videoModelFamily))) {
        throw new Error(`当前模型目录没有 ${videoModelFamily} 系列的视频模型`);
    }
    if (videoModelFamily && spec.selectedVideoModel && !videoModelMatchesFamily(spec.selectedVideoModel, videoModelFamily)) {
        throw new Error(`计划指定的模型 ${spec.selectedVideoModel} 不属于 ${videoModelFamily} 系列`);
    }
    spec.videoModelFamily = videoModelFamily || undefined;
    spec.audioModels = selectableModelsByCapability(currentConfig, "audio").map((value) => describeModel(currentConfig, value, "audio"));
    const preparedSkillEvidence = getPreparedFilmSkillEvidence();
    const suppliedSkillEvidence = Array.isArray(rawSpec.skillEvidence) ? rawSpec.skillEvidence as FilmProductionPlanSpec["skillEvidence"] : [];
    const preparedEvidenceByKey = new Map(preparedSkillEvidence.map((item) => [`${item.phase}\u0000${item.skillId}`, item]));
    for (const supplied of suppliedSkillEvidence || []) {
        const actual = preparedEvidenceByKey.get(`${supplied.phase}\u0000${supplied.skillId}`);
        if (!actual || actual.versionId !== supplied.versionId || actual.contentHash !== supplied.contentHash) {
            throw new Error(`技能证据 ${supplied.skillId}/${supplied.phase} 必须来自当前用户刚完成的 skill_prepare 结果`);
        }
    }
    spec.skillEvidence = preparedSkillEvidence;
    const built = buildFilmProductionPlan(spec);
    const manifest = { ...(built.manifest as Record<string, unknown>) };
    if (spec.allowUnknownPricing) manifest.pricing = { status: "unknown", estimateMicros: 0, authorizationRequired: "unbounded" };
    const audioWarning = filmAudioContractWarning(spec, manifest, contract, recordValue(rawInput.brief) || {});
    if (audioWarning) {
        // 只做预篩提醒：不改写合同、不静默降级，也不影响服务端原有判定。
        manifest.preflight = { ...(recordValue(manifest.preflight) || {}), audioContractWarnings: [audioWarning] };
    }
    return { plan: { ...plan, productionSpec: built.persistedSpec, executionManifest: manifest }, steps: built.steps };
}

const NO_AUDIO_POLICIES = new Set([
    "none", "noaudio", "nosound", "silent", "silence", "muted", "mute", "off",
    "静音", "无声", "无音频", "无音轨", "不需要音频", "不需要音轨", "不要音频", "不要音轨",
]);

/** 与后端 productionAudioPolicyRequiresTrack 保持同一口径：空策略不要求音轨，显式无音频不要求，其余都要求。 */
function audioPolicyRequiresTrack(value: unknown) {
    const policy = String(value ?? "").trim().toLowerCase();
    if (!policy) return false;
    const normalized = policy.replace(/[\s\-_/\\.,，。:：()（）!！]/g, "");
    return !NO_AUDIO_POLICIES.has(normalized);
}

/**
 * 后端在渲染/验收阶段用固化的 Brief 合同判定音轨要求；计划阶段提前用同一口径提醒
 * “合同要音轨、但模型没有可控开关”，提醒逐段核验真实音轨。
 * 这是预警字段，不是阻断：是否用原生声音仍由用户/合同决定。
 */
function filmAudioContractWarning(spec: FilmProductionPlanSpec, manifest: Record<string, unknown>, contract: Record<string, unknown>, brief: Record<string, unknown>) {
    const audioMode = String(spec.audioMode || "NATIVE_AUDIO").toUpperCase();
    const requiresAudio = spec.requireAudio === true || contract.requireAudio === true || brief.requireAudio === true
        || audioPolicyRequiresTrack(contract.audioPolicy) || audioPolicyRequiresTrack(brief.audioPolicy);
    if (!requiresAudio || audioMode !== "NATIVE_AUDIO") return undefined;
    const selections = Array.isArray(manifest.selectedModelsBySegment) ? manifest.selectedModelsBySegment as Array<Record<string, unknown>> : [];
    const offenders = selections.filter((item) => item.generateAudio !== true || item.supportsNativeAudio !== true);
    if (!offenders.length) return undefined;
    return {
        code: "native_audio_output_requires_probe",
        severity: "warning",
        detail: "Brief/交付合同要求音轨，但以下视频模型没有可控的生成声音开关。视频可能自带音轨；每段生成后必须探测真实音轨，无声片段不能进入最终渲染。",
        segments: offenders.map((item) => ({
            storyboardRowId: item.storyboardRowId,
            segmentId: item.segmentId,
            model: item.model,
            capabilityRevision: item.capabilityRevision,
        })),
    };
}

async function changeFilmRun(rawInput: Record<string, unknown>, action: "pause" | "resume" | "cancel") {
    return productionRuns.action(String(rawInput.runId || "").trim(), {
        expectedRevision: numberValue(rawInput.expectedRevision) || 0,
        action,
        reason: optionalString(rawInput.reason),
    });
}

export function buildFilmModelSelection(config: AiConfig, capability: CanvasGenerationMode, rawInput: Record<string, unknown>, explicitValue?: unknown) {
    const explicitModel = Boolean(optionalString(explicitValue));
    const requested = resolveModelForMode(config, capability, explicitValue);
    if (!requested) throw new Error(`当前没有可用的${modeLabel(capability)}模型，请先在设置 → 模型渠道中配置`);
    const availableModels = selectableModelsByCapability(config, capability);
    if (!availableModels.includes(requested)) throw new Error(`模型 ${requested} 不在当前${modeLabel(capability)}模型目录中`);
    const videoModelFamily = capability === "video" ? requestedVideoModelFamily(rawInput) : "";
    if (explicitModel && videoModelFamily && !videoModelMatchesFamily(requested, videoModelFamily)) {
        throw new Error(`用户指定的模型 ${requested} 不属于本次限定的 ${videoModelFamily} 系列`);
    }
    const requirements = buildModelRequirements(config, capability, rawInput);
    const error = modelCompatibilityError(config, requested, requirements);
    if (explicitModel && error) throw new Error(`用户指定的${modeLabel(capability)}模型 ${requested} 不满足当前任务：${error}`);
    const compatibleModels = filmCompatibleModels(config, capability, requirements, requested, true, videoModelFamily);
    const model = explicitModel ? requested : compatibleModels[0] || "";
    if (!model) throw new Error(`没有满足当前${modeLabel(capability)}任务约束的模型；请查看 film_list_models 的 compatible 列表`);
    const finalError = modelCompatibilityError(config, model, requirements);
    if (finalError) throw new Error(`没有满足当前${modeLabel(capability)}任务约束的模型：${finalError}`);
    const channel = resolveModelChannel(config, model);
    const modelKey = modelOptionName(model);
    const cost = channel.modelCosts?.find((item) => item.model === modelKey);
    if (!cost?.channelModelId || !Number.isInteger(cost.capabilityVersion)) {
        throw new Error(`模型 ${model} 没有可核验的服务端能力版本，不能提交制作步骤`);
    }
    const revision = `${cost.channelModelId}:${cost.capabilityVersion}`;
    return { model, requested, switched: model !== requested, explicit: explicitModel, capabilityRevision: revision, requirements };
}

async function submitFilmStep(rawInput: Record<string, unknown>, canvasNodes?: CanvasNodeData[]) {
    const runId = String(rawInput.runId || "").trim();
    const stepId = String(rawInput.stepId || "").trim();
    const idempotencyKey = String(rawInput.idempotencyKey || "").trim();
    const run = await productionRuns.get(runId);
    const unknownPricingAuthorized = String(run.policy?.authorizationStatus || "").toLowerCase() === "authorized"
        && String(run.policy?.budgetPolicy || "").toLowerCase() === "unbounded";
    const step = run.steps.find((item) => item.id === stepId);
    if (!step) throw new Error(`制作步骤 ${stepId} 不存在；请重新读取 film_get_run`);
    const task = bindProductionTaskCanvasContext(
        { ...(recordValue(rawInput.task) || {}) } as ProductionTaskRequest,
        run,
        step,
        canvasNodes,
    );
    const videoModelFamily = normalizeFamily(optionalString(run.policy?.videoModelFamily) || "");
    if (videoModelFamily && taskCapability(task) === "video" && task.model && !videoModelMatchesFamily(task.model, videoModelFamily)) {
        throw new Error(`本次制作已限定 ${videoModelFamily} 系列，不能提交模型 ${task.model}`);
    }
    const plannedSelection = parsePlannedModelSelection(step.selectedStrategyId || "");
    if (videoModelFamily && step.kind === "video" && plannedSelection && !videoModelMatchesFamily(plannedSelection.model, videoModelFamily)) {
        throw new Error(`步骤计划中的模型 ${plannedSelection.model} 不属于已限定的 ${videoModelFamily} 系列`);
    }
    if (task.model && plannedSelection && legalModelValue(currentEffectiveConfig(), task.model) !== plannedSelection.model) {
        throw new Error(`步骤计划已锁定模型 ${plannedSelection.model}，本次请求指定了 ${task.model}；请更新计划并重新授权`);
    }
    if (!task.model && plannedSelection) task.model = plannedSelection.model;
    const estimatedCostMicros = numberValue(rawInput.estimatedCostMicros) ?? numberValue(step.estimatedCostMicros) ?? (unknownPricingAuthorized ? 0 : undefined);
    const requestInput: Record<string, unknown> = { ...rawInput, runId, stepId, idempotencyKey, estimatedCostMicros, videoModelFamily, task };
    const priorAttempt = run.attempts.find((attempt) => attempt.idempotencyKey === idempotencyKey);
    if (priorAttempt) {
        // A transport retry must reuse the immutable model revision and cannot create a new paid attempt.
        const result = await productionRuns.submitStep(runId, {
            expectedRevision: numberValue(rawInput.expectedRevision) || 0,
            stepId,
            idempotencyKey,
            capabilityRevision: priorAttempt.capabilityRevision,
            estimatedCostMicros: requireEstimatedCost(estimatedCostMicros, unknownPricingAuthorized),
            retryOf: optionalString(rawInput.retryOf),
            task,
        });
        return { ...result, modelSelection: { model: task.model || "", capabilityRevision: priorAttempt.capabilityRevision, explicit: Boolean(rawInput.task && recordValue(rawInput.task)?.model), idempotentReplay: true } };
    }
    if (plannedSelection?.capabilityRevision) requestInput.capabilityRevision = plannedSelection.capabilityRevision;
    const { request, modelSelection } = buildFilmSubmitRequest(requestInput, currentEffectiveConfig(), unknownPricingAuthorized);
    if (plannedSelection?.capabilityRevision && plannedSelection.capabilityRevision !== modelSelection.capabilityRevision) {
        throw new Error(`计划使用的视频模型能力版本 ${plannedSelection.capabilityRevision} 已变化为 ${modelSelection.capabilityRevision}；必须更新计划并重新授权`);
    }
    const result = await productionRuns.submitStep(runId, request);
    return { ...result, modelSelection };
}

export function buildFilmSubmitRequest(rawInput: Record<string, unknown>, config: AiConfig, unknownPricingAuthorized = false) {
    const task = { ...(recordValue(rawInput.task) as ProductionTaskRequest) };
    const estimatedCostMicros = requireEstimatedCost(numberValue(rawInput.estimatedCostMicros), unknownPricingAuthorized);
    const capability = taskCapability(task);
    const selection = buildFilmModelSelection(config, capability, { ...taskModelRequirements(task), videoModelFamily: rawInput.videoModelFamily }, task.model);
    task.model = selection.model;
    const providedRevision = optionalString(rawInput.capabilityRevision);
    if (providedRevision && providedRevision !== selection.capabilityRevision) {
        throw new Error("提交的模型能力版本与当前模型目录不一致，请重新读取 film_list_models");
    }
    return {
        runId: String(rawInput.runId || "").trim(),
        request: {
        expectedRevision: numberValue(rawInput.expectedRevision) || 0,
        stepId: String(rawInput.stepId || "").trim(),
        idempotencyKey: String(rawInput.idempotencyKey || "").trim(),
        capabilityRevision: selection.capabilityRevision,
        estimatedCostMicros,
        retryOf: optionalString(rawInput.retryOf),
        task,
        },
        modelSelection: selection,
    };
}

function taskCapability(task: ProductionTaskRequest): CanvasGenerationMode {
    const input = task.input || {};
    const declared = normalizeMode(input.mode);
    if (declared) return declared;
    const type = `${task.type} ${task.operation || ""}`.toLowerCase();
    if (type.includes("video")) return "video";
    if (type.includes("image")) return "image";
    if (type.includes("audio")) return "audio";
    if (type.includes("text")) return "text";
    throw new Error(`无法从任务类型 ${task.type} 确认模型能力；请在 task.input.mode 中声明 text/image/video/audio`);
}

function taskModelRequirements(task: ProductionTaskRequest): Record<string, unknown> {
    const input = task.input || {};
    return {
        ...input,
        input: {
            textCount: 1,
            imageCount: numberValue(input.imageCount) ?? countMedia(input.referenceImages ?? input.imageUrls ?? input.referenceImageUrls) + (input.firstFrame ? 1 : 0),
            videoCount: numberValue(input.videoCount) ?? countMedia(input.referenceVideos ?? input.videoUrls ?? input.referenceVideoUrls),
            audioCount: numberValue(input.audioCount) ?? countMedia(input.referenceAudios ?? input.audioUrls ?? input.referenceAudioUrls),
            characterCount: numberValue(input.characterCount) ?? countMedia(input.characterIds ?? input.characterReferences),
        },
        options: input.options && typeof input.options === "object" && !Array.isArray(input.options) ? input.options : input,
        videoSeconds: input.videoSeconds ?? input.durationSeconds ?? input.requestedDurationSeconds,
        videoOperation: input.videoOperation ?? input.operation,
        videoRatio: input.videoRatio ?? input.aspectRatio ?? input.ratio,
        videoResolution: input.videoResolution ?? input.resolution ?? input.vquality,
        videoGenerateAudio: input.videoGenerateAudio ?? input.generateAudio,
        videoWatermark: input.videoWatermark ?? input.watermark,
    };
}

function countMedia(value: unknown) {
    if (Array.isArray(value)) return value.length;
    return value ? 1 : 0;
}

function requireEstimatedCost(value: number | undefined, unknownPricingAuthorized = false) {
    if (value === undefined || !Number.isInteger(value) || value < 0 || (value === 0 && !unknownPricingAuthorized)) throw new Error("必须提供正数费用预估；只有已授权的无上限预算可以提交未知费用步骤，0 表示未知而非免费");
    return value;
}

function parsePlannedModelSelection(strategyId: string) {
    const at = strategyId.lastIndexOf("@");
    if (at <= 0) return undefined;
    const [revision, operation] = strategyId.slice(at + 1).split(/:(?=[^:]+$)/);
    if (!operation || !/^[^:]+:\d+$/.test(revision)) return undefined;
    return { model: strategyId.slice(0, at), capabilityRevision: revision, operation };
}
function currentEffectiveConfig() {
    const config = useConfigStore.getState().config;
    const customChannelsEnabled = useUserStore.getState().features.customChannelsEnabled;
    return effectiveConfigForCustomChannels(config, customChannelsEnabled);
}

// 模型目录：默认模型 + 每个能力可选模型 + 能力约束，让 Agent 不靠猜模型名。
function listFilmModels(rawInput: Record<string, unknown>) {
    const config = currentEffectiveConfig();
    const capabilities = ["text", "image", "video", "audio"] as const;
    const models = capabilities.flatMap((capability) => selectableModelsByCapability(config, capability).map((value) => describeModel(config, value, capability)));
    const defaults = {
        text: resolveModeDefault(config, "text"),
        image: resolveModeDefault(config, "image"),
        video: resolveModeDefault(config, "video"),
        audio: resolveModeDefault(config, "audio"),
    };
    const capability = normalizeMode(rawInput.capability);
    const videoModelFamily = capability === "video" ? requestedVideoModelFamily(rawInput) : "";
    const requirements = capability ? buildModelRequirements(config, capability, rawInput) : undefined;
    const requested = legalModelValue(config, rawInput.model) || (capability ? defaults[capability] : "");
    const compatible = capability && requirements
        ? models.filter((model) => model.capability === capability && (!videoModelFamily || videoModelMatchesFamily(model.value, videoModelFamily)) && !modelCompatibilityError(config, model.value, requirements))
        : [];
    if (capability === "video" && audioOutputRequired(rawInput)) compatible.sort((left, right) => audioOutputPriority(right.supports) - audioOutputPriority(left.supports));
    const explicitModel = Boolean(optionalString(rawInput.model));
    const requestedCompatible = Boolean(requested && (!videoModelFamily || videoModelMatchesFamily(requested, videoModelFamily)) && (!requirements || !modelCompatibilityError(config, requested, requirements)));
    const recommended = requested && requirements && capability
        ? explicitModel ? requestedCompatible ? requested : "" : filmCompatibleModels(config, capability, requirements, requested, true, videoModelFamily, audioOutputRequired(rawInput))[0] || ""
        : requested;
    const versionedModels = models.filter((model) => model.supports.capabilityRevisionKnown === true);
    const videoModels = models.filter((model) => model.capability === "video");
    const audioModels = models.filter((model) => model.capability === "audio");
    const productionBlockers: Array<{ code: string; detail: string }> = [];
    if (models.length && !versionedModels.length) {
        productionBlockers.push({
            code: "server_model_catalog_empty",
            detail: "当前模型只在网页配置中可见，没有可核验的后端模型能力版本；可以在画布使用原生生成工具，但 film_submit_step 不能提交这些模型。需把渠道和模型接入后端模型目录。",
        });
    }
    if (!audioModels.length && !videoModels.some((model) => model.supports.generateAudio === true)) {
        productionBlockers.push({
            code: "native_audio_control_unverified",
            detail: "当前没有独立音频模型，视频模型也未声明可控的原声音轨开关。视频文件可能自带音轨，但不能保证每次都有；有声漫剧需要验收实际音轨或配置独立音频模型。",
        });
    }
    const unknownMediaPricingModelCount = models.filter((model) => (model.capability === "image" || model.capability === "video") && model.supports.pricingKnown !== true).length;
    return {
        defaults,
        models,
        videoModelFamily,
        audioOutputRequired: capability === "video" && audioOutputRequired(rawInput),
        requested,
        recommended: recommended || "",
        explicit: explicitModel,
        requestedCompatible,
        requestedSubmissionReady: Boolean(requestedCompatible && requested && hasVersionedCapability(config, requested)),
        recommendedSubmissionReady: Boolean(recommended && hasVersionedCapability(config, recommended)),
        productionReadiness: {
            versionedModelCount: versionedModels.length,
            videoModelCount: videoModels.length,
            audioModelCount: audioModels.length,
            audioSwitchSupportedVideoModelCount: videoModels.filter((model) => model.supports.generateAudio === true).length,
            mediaPricing: unknownMediaPricingModelCount > 0
                ? { status: "unknown", models: unknownMediaPricingModelCount, requiredPolicy: "verified estimate or explicitly authorized unbounded budget" }
                : { status: "known", models: 0 },
            blockers: productionBlockers,
            nextTools: productionBlockers.some((item) => item.code === "server_model_catalog_empty")
                ? ["film_sync_local_models", "film_list_models"]
                : ["film_validate_strategy"],
        },
        compatible: compatible.map((model) => ({ ...model })),
        guidance: [
            "视频模型按当前任务的操作、参考输入、时长、画幅、分辨率、原生音频和水印能力筛选；未指定时从全部兼容且有服务端能力版本的模型中自动选择。",
            "用户明确指定模型时必须锁定该模型；不兼容或缺少服务端能力版本时停止并说明原因，不要静默切换。",
            "未知费用不代表免费。使用已核验的正数预估，或必须先取得用户明确无上限费用授权；仅在授权后的持久 ProductionRun 中才可将 estimateMicros=0 表示未知价格。",
            "capabilityRevisionKnown=false 表示模型仅能展示，不能作为持久制作步骤提交。",
        ],
    };
}

function describeModel(config: AiConfig, value: string, capability: "text" | "image" | "video" | "audio") {
    const channel = resolveModelChannel(config, value);
    const modelKey = modelOptionName(value);
    const profile = modelCapabilityConfigFor(config, value);
    const cost = channel.modelCosts?.find((item) => item.model === modelKey);
    const evidence = capabilityEvidenceFromConfig(cost?.capabilityConfig);
    const supports: Record<string, unknown> = {
        protocol: cost?.protocol || channel.interfaceType || "",
        // 局部观测只代表对应 feature 的样本结论，不把整份能力声明升级为实测。
        provenance: cost?.capabilityConfig ? "declared" : "fallback",
        ...(evidence.length ? { evidence } : {}),
        pricingKnown: false,
    };
    if (capability === "image" && profile.image) {
        supports.inputSlots = {
            text: { required: true, min: 1, max: 1 },
            image: { required: false, min: 0, max: profile.image.references.maxImages },
            mask: { required: false, min: 0, max: profile.image.references.maskSupported ? 1 : 0 },
        };
        supports.maxReferenceImages = profile.image.references.maxImages;
        supports.maskSupported = profile.image.references.maskSupported;
        supports.sizes = profile.image.size.values;
        supports.sizeParameter = profile.image.size.parameter;
        supports.sizeAllowCustom = profile.image.size.allowCustom;
        supports.qualities = profile.image.quality.supported ? profile.image.quality.values : [];
        supports.maxOutputs = profile.image.maxOutputs;
        supports.transparentBackground = profile.image.transparentBackground.supported;
    }
    if (capability === "video" && profile.video) {
        const operations = [...profile.video.operations];
        supports.operations = operations;
        const frameSlots = profile.video.references.frameSlots || curatedVideoFrameSlots(modelKey);
        supports.inputSlots = {
            text: { required: true, min: 1, max: 1 },
            firstFrame: frameSlots
                ? { required: frameSlots.firstFrame.min > 0, ...frameSlots.firstFrame, operations: frameSlots.operations }
                : { required: profile.video.references.minImages > 0, min: profile.video.references.minImages, max: profile.video.references.maxImages, operations: operations.filter((operation) => operation.includes("image") || operation.includes("reference")) },
            lastFrame: frameSlots
                ? { required: frameSlots.lastFrame.min > 0, ...frameSlots.lastFrame, operations: frameSlots.operations }
                : { required: false, min: 0, max: operations.some((operation) => /first.*last|last.*frame/i.test(operation)) ? 1 : 0, operations: operations.filter((operation) => /first.*last|last.*frame/i.test(operation)) },
            referenceImage: { required: false, min: 0, max: profile.video.references.maxImages, operations: operations.filter((operation) => operation.includes("reference")) },
            referenceVideo: { required: false, min: 0, max: profile.video.references.maxVideos },
            referenceAudio: { required: false, min: 0, max: profile.video.references.maxAudios },
        };
        supports.maxReferenceImages = profile.video.references.maxImages;
        supports.minReferenceImages = profile.video.references.minImages;
        supports.maxReferenceVideos = profile.video.references.maxVideos;
        supports.maxReferenceAudios = profile.video.references.maxAudios;
        supports.maxReferenceImageBytes = profile.video.references.maxImageBytes;
        supports.maxReferenceVideoBytes = profile.video.references.maxVideoBytes;
        supports.maxReferenceAudioBytes = profile.video.references.maxAudioBytes;
        supports.maxReferenceVideoDurationSeconds = profile.video.references.maxVideoDurationSeconds;
        supports.maxReferenceAudioDurationSeconds = profile.video.references.maxAudioDurationSeconds;
        supports.durationSupported = profile.video.durationSupported !== false;
        supports.duration = profile.video.duration.selection === "enum"
            ? { mode: "enum", values: profile.video.duration.values || [], default: profile.video.duration.default }
            : { mode: "range", min: profile.video.duration.min, max: profile.video.duration.max, step: profile.video.duration.step, default: profile.video.duration.default };
        supports.ratios = profile.video.ratios;
        supports.resolutions = profile.video.resolutions;
        supports.generateAudio = profile.video.generateAudio.supported;
        supports.generateAudioDefault = profile.video.generateAudio.default;
        supports.watermark = profile.video.watermark.supported;
        const audioSamples = evidence.filter((item) => item.feature === "native_audio_output" && item.source === "media_probe");
        supports.observedVideoOutputs = evidence
            .filter((item) => item.feature === "video_output_profile" && item.source === "media_probe")
            .map((item) => ({ verdict: item.verdict, at: item.at, reason: item.reason, details: item.details }))
            .slice(-6);
        const nativeAudioObserved = audioSamples.some((item) => item.verdict === "supported");
        const silentAudioObserved = audioSamples.some((item) => item.verdict === "silent");
        supports.audioCapabilities = {
            // An unsupported on/off parameter does not prove that the encoded
            // video has no audio track. Some relays emit one without a switch.
            nativeAudio: nativeAudioObserved && silentAudioObserved ? "inconsistent" : nativeAudioObserved ? "observed" : profile.video.generateAudio.supported ? "declared" : "unknown",
            referenceAudio: profile.video.references.maxAudios > 0 ? "declared" : "unsupported",
            audioDrivenVideo: operations.includes("audio_to_video") ? "declared" : "unsupported",
            dialogueControl: "unknown",
            voiceReference: "unknown",
            lipSync: "unknown",
            music: "unknown",
            soundEffects: "unknown",
        };
        supports.dialogueObservation = videoDialogueObservation(cost?.capabilityConfig?.observed) || { sampleCount: 0, reliability: "unverified", summary: "对白未实测" };
    }
    if (capability === "text" && profile.text) {
        supports.streaming = profile.text.streaming;
        supports.thinking = profile.text.thinking;
        supports.maxReferenceImages = profile.text.references.maxImages;
        supports.maxReferenceVideos = profile.text.references.maxVideos;
        supports.inputSlots = {
            text: { required: true, min: 1, max: 1 },
            image: { required: false, min: 0, max: profile.text.references.maxImages },
            video: { required: false, min: 0, max: profile.text.references.maxVideos },
        };
    }
    if (capability === "audio") {
        const audioCapabilities = profile.audio || defaultAudioCapabilityConfig();
        supports.inputSlots = {
            text: { required: true, min: 1, max: 1 },
            character: { required: false, min: 0, max: 1 },
        };
        supports.audioCapabilities = {
            tts: audioCapabilities.tts,
            voiceDesign: audioCapabilities.voiceDesign,
            voiceReference: audioCapabilities.voiceReference,
            ambientSound: audioCapabilities.ambientSound,
            soundEffects: audioCapabilities.soundEffects,
            music: audioCapabilities.music,
            speechRecognition: audioCapabilities.speechRecognition,
            alignment: audioCapabilities.alignment,
            parameters: {
                voiceId: audioCapabilities.voiceIdParameter || "",
                referenceAudio: audioCapabilities.referenceAudioParameter || "",
                tone: audioCapabilities.toneParameter || "",
                emotionStyle: audioCapabilities.emotionStyleParameter || "",
                speakingRate: audioCapabilities.speakingRateParameter || "",
                language: audioCapabilities.languageParameter || "",
                accent: audioCapabilities.accentParameter || "",
            },
            voiceIds: audioCapabilities.voiceIds || [],
            defaultVoiceId: audioCapabilities.defaultVoiceId || "",
        };
    }
    supports.capabilityRevisionKnown = Boolean(cost?.channelModelId && Number.isInteger(cost.capabilityVersion));
    supports.capabilityRevision = supports.capabilityRevisionKnown ? `${cost!.channelModelId}:${cost!.capabilityVersion}` : "";
    const name = cost?.displayName?.trim() || modelKey;
    return {
        value,
        name,
        description: cost?.description?.trim() || "",
        label: `${channel.name || "默认渠道"} · ${name}`,
        capability,
        channelId: channel.id,
        channelName: channel.name,
        modelKey,
        supports,
    };
}

function curatedVideoFrameSlots(modelKey: string) {
    // These two upstream SKUs explicitly require a start and end frame. Other
    // H3 models that accept multiple reference images remain reference-image models.
    if (!["minimax_h3_b99_002", "minimax_h3_lightx2v"].includes(modelKey.trim().toLowerCase())) return undefined;
    return {
        firstFrame: { min: 1, max: 1 },
        lastFrame: { min: 1, max: 1 },
        operations: ["image_to_video"],
    };
}

function filmCompatibleModels(config: AiConfig, capability: CanvasGenerationMode, requirements: ModelRequirements, preferred: string, requireVersion = true, videoModelFamily = "", prioritizeAudioOutput = false) {
    const ordered = [preferred, ...selectableModelsByCapability(config, capability).filter((model) => model !== preferred)];
    const compatible = ordered.filter((model) => (!videoModelFamily || capability !== "video" || videoModelMatchesFamily(model, videoModelFamily)) && !modelCompatibilityError(config, model, requirements));
    if (capability === "video" && prioritizeAudioOutput) compatible.sort((left, right) => audioOutputPriority(describeModel(config, right, "video").supports) - audioOutputPriority(describeModel(config, left, "video").supports));
    if (!requireVersion) return compatible;
    return compatible.filter((model) => hasVersionedCapability(config, model));
}

function audioOutputRequired(rawInput: Record<string, unknown>) {
    return rawInput.audioOutputRequired === true || recordValue(rawInput.options)?.audioOutputRequired === true;
}

function audioOutputPriority(supports: Record<string, unknown>) {
    if (supports.generateAudio === true) return 2;
    return (supports.audioCapabilities as Record<string, unknown> | undefined)?.nativeAudio === "observed" ? 1 : 0;
}

function requestedVideoModelFamily(rawInput: Record<string, unknown>) {
    return normalizeFamily(optionalString(rawInput.videoModelFamily) || optionalString(recordValue(rawInput.options)?.videoModelFamily) || "");
}

function hasVersionedCapability(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    const cost = channel.modelCosts?.find((item) => item.model === modelOptionName(model));
    return Boolean(cost?.channelModelId && Number.isInteger(cost.capabilityVersion));
}

function resolveModeDefault(config: AiConfig, mode: CanvasGenerationMode) {
    const raw = mode === "image" ? config.imageModel : mode === "video" ? config.videoModel : mode === "audio" ? config.audioModel : config.textModel;
    return legalModelValue(config, raw || config.model || "");
}

// 默认模型与用户指定模型都先归一成合法模型选项（channelId::model）：兼容路由按「同显示名
// 分组」落档，裸模型名会找不到分组而静默跳过切换。认不出来的名字原样保留，让底层校验
// 如实报错，而不是在这里放宽校验。
function legalModelValue(config: AiConfig, value: unknown) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (!raw.includes("::")) {
        const matches = config.channels.filter((channel) => channel.models.includes(raw) || Boolean(channel.modelAliases?.[raw]));
        if (matches.length > 1) throw new Error(`模型名 ${raw} 存在于多个渠道，请明确选择渠道型号`);
    }
    return normalizeModelOptionValue(raw, config.channels) || raw;
}

// 从工具入参构造能力约束，复用产品现有的图片/视频/音频兼容性判定。
function buildModelRequirements(config: AiConfig, mode: CanvasGenerationMode, rawInput: Record<string, unknown>): ModelRequirements {
    const options = rawInput.options && typeof rawInput.options === "object" && !Array.isArray(rawInput.options)
        ? rawInput.options as Record<string, unknown>
        : undefined;
    const input = rawInput.input && typeof rawInput.input === "object" && !Array.isArray(rawInput.input)
        ? rawInput.input as Record<string, unknown>
        : undefined;
    const count = (key: string) => {
        const value = Number(input?.[key]);
        return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    };
    const normalizedOptions: Record<string, unknown> = { ...modelRequestOptions(config, mode), ...(options || {}) };
    if (mode === "video") {
        const firstValue = (...values: unknown[]) => values.find((value) => value !== undefined && value !== null && value !== "");
        // Video defaults belong to each model's capability profile. Strip the
        // global canvas values before routing; only values present in this tool
        // request may constrain the candidate model.
        delete normalizedOptions.size;
        delete normalizedOptions.videoSeconds;
        delete normalizedOptions.vquality;
        delete normalizedOptions.videoGenerateAudio;
        delete normalizedOptions.videoWatermark;
        const videoSeconds = firstValue(rawInput.videoSeconds, rawInput.durationSeconds, rawInput.requestedDurationSeconds, options?.videoSeconds, options?.durationSeconds);
        const videoRatio = firstValue(rawInput.videoRatio, rawInput.aspectRatio, rawInput.ratio, options?.videoRatio, options?.aspectRatio, options?.ratio, options?.size);
        const videoResolution = firstValue(rawInput.videoResolution, rawInput.resolution, rawInput.vquality, options?.videoResolution, options?.resolution, options?.vquality);
        const generateAudio = firstValue(rawInput.videoGenerateAudio, rawInput.generateAudio, options?.videoGenerateAudio, options?.generateAudio);
        const watermark = firstValue(rawInput.videoWatermark, rawInput.watermark, options?.videoWatermark, options?.watermark);
        if (videoSeconds !== undefined) normalizedOptions.videoSeconds = videoSeconds;
        if (videoRatio !== undefined) normalizedOptions.size = videoRatio;
        if (videoResolution !== undefined) normalizedOptions.vquality = videoResolution;
        if (generateAudio !== undefined) normalizedOptions.videoGenerateAudio = generateAudio;
        if (watermark !== undefined) normalizedOptions.videoWatermark = watermark;
    }
    const requirements: ModelRequirements = { capability: mode, options: normalizedOptions };
    if (input) {
        requirements.input = { textCount: count("textCount"), imageCount: count("imageCount"), videoCount: count("videoCount"), audioCount: count("audioCount"), characterCount: count("characterCount") };
    }
    const imageSize = optionalString(rawInput.imageSize ?? options?.size);
    if (imageSize) requirements.imageSize = imageSize;
    const videoSeconds = optionalString(rawInput.videoSeconds ?? rawInput.durationSeconds ?? rawInput.requestedDurationSeconds ?? options?.videoSeconds ?? options?.durationSeconds);
    if (videoSeconds) requirements.videoSeconds = videoSeconds;
    const videoOperation = optionalString(rawInput.videoOperation ?? options?.videoOperation);
    if (videoOperation) requirements.videoOperation = videoOperation;
    const videoRatio = optionalString(rawInput.videoRatio ?? rawInput.aspectRatio ?? rawInput.ratio ?? options?.videoRatio ?? options?.aspectRatio ?? options?.ratio ?? options?.size);
    if (videoRatio) requirements.videoRatio = videoRatio;
    const videoResolution = optionalString(rawInput.videoResolution ?? rawInput.resolution ?? rawInput.vquality ?? options?.videoResolution ?? options?.resolution ?? options?.vquality);
    if (videoResolution) requirements.videoResolution = videoResolution;
    const requestedAudio = rawInput.videoGenerateAudio ?? rawInput.generateAudio ?? options?.videoGenerateAudio ?? options?.generateAudio;
    const requestedWatermark = rawInput.videoWatermark ?? rawInput.watermark ?? options?.videoWatermark ?? options?.watermark;
    if (typeof requestedAudio === "boolean") requirements.videoGenerateAudio = requestedAudio;
    if (typeof requestedWatermark === "boolean") requirements.videoWatermark = requestedWatermark;
    return requirements;
}

function resolveModelForMode(config: AiConfig, mode: CanvasGenerationMode, requested: unknown) {
    const explicit = legalModelValue(config, requested);
    if (explicit) return explicit;
    if (mode === "image") return legalModelValue(config, config.imageModel || config.model);
    if (mode === "video") return legalModelValue(config, config.videoModel || config.model);
    if (mode === "audio") return legalModelValue(config, config.audioModel || config.model);
    return legalModelValue(config, config.textModel || config.model);
}

async function operationLabel(operation: string) {
    try {
        const { definitions } = await listAdminPromptTemplates();
        return definitions.find((definition) => definition.operation === operation)?.label || operation;
    } catch {
        return operation;
    }
}

function normalizeVariables(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const variables: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const name = key.trim();
        if (!name) continue;
        variables[name] = typeof item === "string" ? item : JSON.stringify(item);
    }
    return variables;
}

function normalizeMode(value: unknown): CanvasGenerationMode | "" {
    const mode = String(value || "").trim().toLowerCase();
    return mode === "text" || mode === "image" || mode === "video" || mode === "audio" ? mode : "";
}

function modeLabel(mode: CanvasGenerationMode) {
    if (mode === "image") return "图片";
    if (mode === "video") return "视频";
    if (mode === "audio") return "音频";
    return "文本";
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.round(parsed)));
}

function recordValue(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberValue(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function optionalString(value: unknown) {
    const text = String(value ?? "").trim();
    return text || undefined;
}

function delay(ms: number) {
    return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

// capabilityEvidenceFromConfig 把持久化的实测结论整理成 Agent 可直接读的证据列表。
export function capabilityEvidenceFromConfig(config: unknown) {
    if (!config || typeof config !== "object") return [];
    const observed = (config as Record<string, unknown>).observed;
    if (!Array.isArray(observed)) return [];
    return observed
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .slice(-6)
        .map((item) => ({ verdict: String(item.verdict || ""), feature: String(item.feature || ""), reason: String(item.reason || ""), source: String(item.source || ""), at: String(item.at || ""), ...(item.details && typeof item.details === "object" ? { details: item.details } : {}) }))
        .filter((item) => Boolean(item.verdict || item.feature));
}

function parseVideoTaskInputEvidence(inputJson?: string) {
    try {
        const parsed = JSON.parse(inputJson || "null") as Record<string, unknown> | null;
        const taskInput = parsed?.input && typeof parsed.input === "object" ? parsed.input as Record<string, unknown> : parsed;
        if (!taskInput) return undefined;
        const counts: Record<string, number> = {};
        for (const key of ["referenceImages", "referenceVideos", "referenceAudios"] as const) {
            const value = taskInput[key];
            if (Array.isArray(value)) counts[key] = value.length;
        }
        return Object.keys(counts).length ? counts : undefined;
    } catch {
        return undefined;
    }
}
