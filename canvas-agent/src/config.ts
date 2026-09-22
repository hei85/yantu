import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RuntimeBrowserRegistration } from "./local-runtime-session.js";

export const LOCAL_RUNTIME_DEFAULT_PORT = 17371;
/** @deprecated Use LOCAL_RUNTIME_DEFAULT_PORT. */
export const DEFAULT_PORT = LOCAL_RUNTIME_DEFAULT_PORT;
export const CONFIG_DIR = startupConfigDirectory();
export const CONFIG_FILE = path.join(CONFIG_DIR, "canvas-agent.json");
export const VERSION = readPackageVersion();
export const AGENT_PROMPT = `你是衍图的画布执行 Agent，不是只会生成 JSON 的聊天机器人。你的第一责任是基于真实画布状态完成可验证的结果。

【上下文协议】
- 涉及“这个/当前/已有/选中的”对象时，先 canvas_get_context；用户明确指向选中对象时再补 canvas_get_selection。
- 不要从记忆或用户描述猜节点 id。需要找节点时用 canvas_find_nodes；已经知道真实 id 时用 canvas_get_node 或 canvas_get_connection 做精确复核；需要观察生成进度时用 canvas_get_generation_tasks；需要判断媒体能否作为参考时用 canvas_get_resources。
- canvas_get_context 返回 stateHash、语义化节点、连接关系和资源就绪状态。资源 ready=false、status=loading/error 或只有占位 metadata 时，必须明确说明，不要把它当成可用素材。

【执行协议】
- 任何写操作前先读取上下文；复杂批量写操作先调用 canvas_validate_ops，再调用 canvas_apply_ops。
- 写操作只使用当前上下文中真实存在的 id；新增节点要避免重叠，优先沿现有内容的右侧或下方网格布局。
- 操作完成后检查工具返回的真实结果；如果没有改变、部分失败或生成仍在进行，必须如实报告，不要说“已完成”。
- 删除、覆盖、批量移动、触发生成属于高影响操作，先给出简短计划并等待网页侧确认；不要用模拟鼠标点击绕过确认。
- 流水线、工作流、管线、节点图或用户明确要求连线时，必须使用 canvas_create_workflow：将业务阶段拆成真实的文本/脚本/图片/视频/音频节点；character_cards 表示角色拆分图片卡片，character_three_view 表示角色三视图，storyboard_video 表示分镜剧情视频。媒体节点必须有真实 prompt/content；涉及已有素材时先 canvas_find_nodes/canvas_get_resources，再使用返回的真实 node id 填入 referenceNodeIds。工具会按实际尺寸布局并建立 edges/referenceRefs/referenceNodeIds 连线，禁止把工作流退化成批量空文本节点。
- 优先使用语义化工具（canvas_create_workflow、canvas_create_text_node、canvas_generate_*、canvas_update_node_text 等），只有确实需要批量事务时才使用 canvas_apply_ops。

【资源与生成】
- 生成前先检查已有提示词、参考节点、资产引用和就绪状态；有合适资源就复用真实 node id，不要重复上传或创建孤立副本。
- 图片、视频、音频生成必须通过 canvas_generate_image、canvas_generate_video、canvas_generate_audio 进入共享 GenerationTask；禁止调用 direct dreamina_cli provider tool。
- 即使用户点名 Dreamina/即梦，也使用 model=local:dreamina-cli:5.0 这类产品模型值；自动分辨率使用 quality=auto。

【交互边界】
【影视流水线】
- 影视任务优先用衍图已有能力编排：film_list_operations 列出官方 Prompt Operation（短剧大纲、章节资产提取、角色提取、角色三视图、分镜规划、分镜修复、分镜首帧、分镜视频），project_* 负责项目数据，canvas_* 负责画布与生成。开始影视任务前先 film_list_operations，不要编造操作名或自己重写这些提示词。
- 多镜头任务禁止把镜头写成一段 Markdown/Text：必须用 project_create_or_update_shots 写入真实 Script 分镜，每个镜头尽量维护 镜号、时长、剧情描述、对白、叙事目的、人物调度、景别、情绪、灯光氛围、音效、摄影机、运镜、时间节拍、首帧提示词、视频提示词、必备元素、连续性、负面提示词。
- 镜头时长硬上限 15 秒：分镜规划、分镜修复和写入分镜时，每个镜头的 durationSeconds 必须 ≤ 15；超过 15 秒的镜头一律拆成两镜或压缩进 15 秒，禁止把超过 15 秒的镜头提交视频生成，并在回复中说明如何拆分或压缩。
- 标准顺序：film_list_operations → project_get_context → film_run_operation(short_drama_outline) → 导入章节 → film_run_operation(chapter_assets_extract) → project_extract_asset_candidates / project_confirm_asset_candidate → film_run_operation(character_extract) → film_run_operation(character_turnaround)（必要时）→ storyboard_plan → storyboard_repair → project_create_or_update_shots → project_link_shot_asset 逐镜绑定角色/场景/道具 → film_run_operation(storyboard_first_frame) → canvas_generate_image → film_run_operation(storyboard_video) → canvas_generate_video → film_wait_task → project_register_task_output。
- 一致性优先：每镜继承上一镜的角色版本、服装、场景、光线与镜头连续性；参考图必须用真实资产版本 id，不要复制媒体文件。角色/场景/道具确认后再进入分镜生成。
- 失败与重试：先用 film_wait_task 判定终态；失败只重试失败镜头，并复用同一个 clientOperationId；超时说明任务仍在进行，不要重复提交同一镜头。
- 长时间生成：分批用 film_wait_task 等待，把中间进度如实回报；不要用占位结果假装已完成。
- 不要求用户手动复制 JSON、URL、token 或节点 id；不编造工具结果；不把媒体 URL、API key 或 data URL 放进回复。
- 页面文案和画布节点内容默认使用中文。`;

export type CanvasWorkspaceConfig = { workspacePath: string; activeThreadId?: string; pinnedThreadIds?: string[] };
export type LocalRuntimeConfig = {
    url: string;
    token: string;
    ownerId?: string;
    origins?: string[];
    trustedWebOrigins: string[];
    browserRegistrations: RuntimeBrowserRegistration[];
    legacyBootstrap?: boolean;
    canvases?: Record<string, CanvasWorkspaceConfig>;
};
/** @deprecated Use LocalRuntimeConfig. */
export type CanvasAgentConfig = LocalRuntimeConfig;

export function loadConfig(create = false): LocalRuntimeConfig {
    try {
        const config = normalizeLocalRuntimeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")));
        if (create) saveConfig(config);
        return config;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const config = normalizeLocalRuntimeConfig({
            url: `http://127.0.0.1:${Number(process.env.PORT) || DEFAULT_PORT}`,
            token: crypto.randomBytes(18).toString("hex"),
            trustedWebOrigins: configuredTrustedOrigins(),
            browserRegistrations: [],
        });
        if (create) saveConfig(config);
        return config;
    }
}

export function normalizeLocalRuntimeConfig(value: unknown): LocalRuntimeConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Local Runtime config is invalid");
    }
    const input = value as Partial<LocalRuntimeConfig>;
    if (typeof input.url !== "string" || !isLoopbackRuntimeUrl(input.url)) {
        throw new Error("Local Runtime URL must use 127.0.0.1");
    }
    if (typeof input.token !== "string" || !input.token) {
        throw new Error("Local Runtime master token is invalid");
    }
    const trustedWebOrigins = process.env.FRAMEFIELD_TRUSTED_WEB_ORIGINS === undefined
        ? input.trustedWebOrigins ?? configuredTrustedOrigins()
        : configuredTrustedOrigins();
    if (!Array.isArray(trustedWebOrigins)) throw new Error("Trusted Web origins are invalid");
    const normalizedOrigins = trustedWebOrigins.map(exactWebOrigin);
    if (new Set(normalizedOrigins).size !== normalizedOrigins.length) {
        throw new Error("Trusted Web origins must be unique");
    }
    if (input.browserRegistrations !== undefined && !Array.isArray(input.browserRegistrations)) {
        throw new Error("Browser registrations are invalid");
    }
    const config: LocalRuntimeConfig = {
        url: new URL(input.url).origin,
        token: input.token,
        trustedWebOrigins: normalizedOrigins,
        browserRegistrations: [...(input.browserRegistrations ?? [])],
        ...(Array.isArray(input.origins) ? { origins: [...input.origins] } : {}),
        ...(input.legacyBootstrap === true ? { legacyBootstrap: true } : {}),
        ...(input.canvases && typeof input.canvases === "object" ? { canvases: input.canvases } : {}),
        ...(typeof input.ownerId === "string" ? { ownerId: input.ownerId } : {}),
    };
    ensureRuntimeOwnerId(config);
    return config;
}

// Runtime ownership stays in Runtime state and never selects a CLI account/home.
export function ensureRuntimeOwnerId(config: LocalRuntimeConfig) {
    if (!config.ownerId || !/^[A-Za-z0-9_-]{24}$/.test(config.ownerId)) {
        config.ownerId = crypto.randomBytes(18).toString("base64url");
    }
    return config.ownerId;
}

/** @deprecated Use ensureRuntimeOwnerId. */
export const ensureOwnerId = ensureRuntimeOwnerId;

export function saveConfig(config: LocalRuntimeConfig) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function ensureCanvasWorkspace(config: LocalRuntimeConfig, canvasId: string) {
    const id = safeSegment(canvasId || "default");
    config.canvases ||= {};
    const current = config.canvases[id];
    if (current?.workspacePath) {
        fs.mkdirSync(resolveWorkspacePath(current.workspacePath), { recursive: true });
        return { canvasId: id, ...current, workspacePath: resolveWorkspacePath(current.workspacePath) };
    }
    const workspacePath = path.join(CONFIG_DIR, "codex-workspaces", id);
    config.canvases[id] = { workspacePath };
    fs.mkdirSync(workspacePath, { recursive: true });
    saveConfig(config);
    return { canvasId: id, workspacePath };
}

export function updateCanvasWorkspace(config: LocalRuntimeConfig, canvasId: string, patch: Partial<CanvasWorkspaceConfig>) {
    const current = ensureCanvasWorkspace(config, canvasId);
    const workspacePath = patch.workspacePath ? resolveWorkspacePath(patch.workspacePath) : current.workspacePath;
    const next = { ...current, ...patch, workspacePath };
    config.canvases ||= {};
    config.canvases[current.canvasId] = { workspacePath: next.workspacePath, activeThreadId: next.activeThreadId, pinnedThreadIds: next.pinnedThreadIds };
    fs.mkdirSync(workspacePath, { recursive: true });
    saveConfig(config);
    return { canvasId: current.canvasId, ...config.canvases[current.canvasId] };
}

function resolveWorkspacePath(value: string) {
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return path.resolve(value);
}

function safeSegment(value: string) {
    return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "default";
}

function isLoopbackRuntimeUrl(value: string) {
    try {
        const url = new URL(value);
        return url.protocol === "http:"
            && url.hostname === "127.0.0.1"
            && Boolean(url.port)
            && url.pathname === "/"
            && !url.username
            && !url.password
            && !url.search
            && !url.hash;
    } catch {
        return false;
    }
}

function exactWebOrigin(value: unknown) {
    if (typeof value !== "string" || value.includes(",") || value === "null") {
        throw new Error("Trusted Web origin is invalid");
    }
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)
        || url.username
        || url.password
        || url.pathname !== "/"
        || url.search
        || url.hash
        || url.origin !== value) {
        throw new Error("Trusted Web origin is invalid");
    }
    return url.origin;
}

function configuredTrustedOrigins() {
    const configured = process.env.FRAMEFIELD_TRUSTED_WEB_ORIGINS;
    if (!configured) return ["http://127.0.0.1:3000", "http://localhost:3000"];
    return configured.split(",").map((value) => value.trim());
}

function startupConfigDirectory() {
    const configured = process.env.FRAMEFIELD_LOCAL_RUNTIME_CONFIG_DIR;
    if (configured === undefined) return path.join(os.homedir(), ".infinite-canvas");
    if (!configured
        || configured !== configured.trim()
        || configured.length > 2_048
        || !path.isAbsolute(configured)) {
        throw new Error("Local Runtime config directory override must be absolute");
    }
    const resolved = path.resolve(configured);
    if (resolved === path.parse(resolved).root) {
        throw new Error("Local Runtime config directory override cannot be a filesystem root");
    }
    return resolved;
}

function readPackageVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
        return pkg.version || "0.0.0";
    } catch {
        return "0.0.0";
    }
}
