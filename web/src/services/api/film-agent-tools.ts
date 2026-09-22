// 影视流水线工具：把衍图「已有的」生成任务与提示词模板能力直接交给 Codex 调度。
//
// 设计原则：这里不实现任何影视能力本身，只做三件事——
//   1. 列出服务端已经定义的 Prompt Operation（短剧大纲、资产提取、分镜规划……）；
//   2. 用页面同款调用方式（占位提示词 + promptTemplateOperation + 变量）发起生成任务；
//   3. 等待/查询已有任务，避免重复提交。
// 模板渲染、任务生命周期、计费与产物登记全部复用现有后端与页面服务。

import { promptTemplateTaskPlaceholder, PromptTemplateOperation, type PromptTemplateOperationId } from "@/lib/prompts";
import { effectiveConfigForCustomChannels, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasGenerationMode } from "@/types/canvas";
import { listAdminPromptTemplates, type PromptTemplate, type PromptOperationDefinition } from "./auth";
import { parseBackendGenerationResult, runBackendGenerationTask, submitBackendGenerationTask, type BackendGenerationResult } from "./generation-task";
import { queryGenerationTask, type GenerationTask } from "./task-center";

export const filmAgentToolNames = [
    "film_list_operations",
    "film_run_operation",
    "film_wait_task",
] as const;

export type FilmAgentToolName = (typeof filmAgentToolNames)[number];

export function isFilmAgentToolName(value: string): value is FilmAgentToolName {
    return filmAgentToolNames.includes(value as FilmAgentToolName);
}

export function isFilmAgentReadTool(value: string) {
    return value === "film_list_operations";
}

// 影视生成类操作默认走哪条链路：分镜首帧出图、分镜视频出视频，其余（大纲、提取、规划、修复）都是文本推理。
const operationModeOverrides: Partial<Record<PromptTemplateOperationId, CanvasGenerationMode>> = {
    [PromptTemplateOperation.StoryboardFirstFrame]: "image",
    [PromptTemplateOperation.StoryboardVideo]: "video",
};

const terminalTaskStatuses = new Set(["succeeded", "failed", "cancelled"]);

export async function runFilmAgentTool(name: FilmAgentToolName, rawInput: Record<string, unknown>) {
    if (name === "film_list_operations") return listFilmOperations();
    if (name === "film_run_operation") return runFilmOperation(rawInput);
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
            "同一镜头重试时必须复用同一个 clientOperationId，避免重复扣费与重复任务。",
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
        mode: operationModeOverrides[definition.operation as PromptTemplateOperationId] || "text",
        variables: (definition.variables || []).map((variable) => variable.placeholder || variable.label),
        activeTemplate: active ? { id: active.id, version: active.version, updatedAt: active.updatedAt } : null,
    };
}

async function runFilmOperation(rawInput: Record<string, unknown>) {
    const operation = String(rawInput.operation || "").trim();
    if (!operation) throw new Error("缺少 operation：请先用 film_list_operations 查看可用的影视操作");
    const variables = normalizeVariables(rawInput.variables);
    const mode = normalizeMode(rawInput.mode) || operationModeOverrides[operation as PromptTemplateOperationId] || "text";
    const config = currentEffectiveConfig();
    const model = resolveModelForMode(config, mode, rawInput.model);
    if (!model) throw new Error(`当前没有可用的${modeLabel(mode)}模型，请先在设置 → 模型渠道中配置`);
    const awaitCompletion = rawInput.awaitCompletion !== false;
    const timeoutMs = clampNumber(rawInput.timeoutMs, 30_000, 3_600_000, 900_000);
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
        clientOperationId: optionalString(rawInput.clientOperationId),
        signal: AbortSignal.timeout(timeoutMs),
    } satisfies Parameters<typeof runBackendGenerationTask>[0];

    if (!awaitCompletion) {
        const task = await submitBackendGenerationTask(options);
        return { submitted: true, taskId: task.id, status: task.status, mode, operation };
    }

    // 页面同款路径：创建任务并等待完成；期间把任务写回，便于失败后只重试失败的镜头。
    const taskRef: { current: GenerationTask | null } = { current: null };
    const result: BackendGenerationResult = await runBackendGenerationTask({ ...options, onTaskUpdate: (task) => { taskRef.current = task; } });
    return {
        submitted: true,
        taskId: taskRef.current?.id || "",
        status: taskRef.current?.status || "succeeded",
        mode,
        operation,
        variables: Object.keys(variables),
        result,
    };
}

async function waitFilmTask(rawInput: Record<string, unknown>) {
    const taskId = String(rawInput.taskId || "").trim();
    if (!taskId) throw new Error("缺少 taskId");
    const timeoutMs = clampNumber(rawInput.timeoutMs, 1_000, 3_600_000, 600_000);
    const pollMs = clampNumber(rawInput.pollMs, 500, 60_000, 4_000);
    const deadline = Date.now() + timeoutMs;
    let task = await queryGenerationTask(taskId);

    while (!terminalTaskStatuses.has(String(task.status)) && Date.now() < deadline) {
        await delay(pollMs);
        task = await queryGenerationTask(taskId);
    }

    const timedOut = !terminalTaskStatuses.has(String(task.status));
    return {
        taskId,
        status: task.status,
        timedOut,
        progress: task.progress,
        stage: task.stage,
        error: task.error || "",
        result: timedOut ? undefined : parseBackendGenerationResult(task),
        hint: timedOut ? "任务仍在进行：可以稍后再调用一次 film_wait_task，不要重复提交同一镜头。" : "",
    };
}

function currentEffectiveConfig() {
    const config = useConfigStore.getState().config;
    const customChannelsEnabled = useUserStore.getState().features.customChannelsEnabled;
    return effectiveConfigForCustomChannels(config, customChannelsEnabled);
}

function resolveModelForMode(config: AiConfig, mode: CanvasGenerationMode, requested: unknown) {
    const explicit = String(requested || "").trim();
    if (explicit) return explicit;
    if (mode === "image") return config.imageModel || config.model;
    if (mode === "video") return config.videoModel || config.model;
    if (mode === "audio") return config.audioModel || config.model;
    return config.textModel || config.model;
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

function optionalString(value: unknown) {
    const text = String(value ?? "").trim();
    return text || undefined;
}

function delay(ms: number) {
    return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}
