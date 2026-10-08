import {
    confirmProjectAssetCandidate,
    createProject,
    createProjectUnit,
    createProjectAssetVersion,
    createProjectAssetCandidates,
    getProject,
    listProjects,
    linkCanvasUnit,
    linkProjectAsset,
    linkShotAsset,
    listVoiceProfiles,
    bindProjectCharacterVoice,
    registerProjectTaskOutput,
    saveProjectShot,
    updateWorkflowStep,
    updateProject,
    type CanvasUnitLink,
    type ProjectDetail,
    type ShotAssetReference,
} from "./projects";
import { normalizeAssetCategory, type AssetCategory } from "@/lib/asset-category";
import { bindAgentCanvasProject, createAgentCanvasProject, getAgentProjectBootstrap, listAgentCanvasProjects, saveAgentProjectBootstrap, type AgentProjectBootstrap } from "@/lib/canvas/agent-canvas-project-io";

export const projectAgentToolNames = [
    "project_get_context",
    "project_list_units",
    "project_list_voices",
    "project_bind_character_voice",
    "project_create_from_script",
    "project_extract_asset_candidates",
    "project_confirm_asset_candidate",
    "project_create_or_update_shots",
    "project_link_shot_asset",
    "project_start_workflow_step",
    "project_link_asset",
    "project_upsert_asset_version",
    "project_register_task_output",
] as const;

export type ProjectAgentToolName = (typeof projectAgentToolNames)[number];

export function isProjectAgentToolName(value: string): value is ProjectAgentToolName {
    return projectAgentToolNames.includes(value as ProjectAgentToolName);
}

export function isProjectAgentReadTool(value: string) {
    return value === "project_get_context" || value === "project_list_units" || value === "project_list_voices";
}

const projectBootstrapLocks = new Map<string, Promise<unknown>>();

export async function runProjectAgentTool(name: ProjectAgentToolName, rawInput: Record<string, unknown>, fallbackProjectId?: string) {
    if (name === "project_create_from_script") {
        const operationId = String(rawInput.clientOperationId || "").trim();
        const running = projectBootstrapLocks.get(operationId);
        if (running) return running;
        const work = runScriptProjectBootstrap(rawInput).finally(() => projectBootstrapLocks.delete(operationId));
        projectBootstrapLocks.set(operationId, work);
        return work;
    }
    const projectId = String(rawInput.projectId || fallbackProjectId || "").trim();
    if (!projectId) throw new Error("当前画布没有关联短剧项目");
    if (name === "project_get_context") return getProject(projectId);
    if (name === "project_list_units") {
        const detail = await getProject(projectId);
        const kind = String(rawInput.kind || "").trim();
        const status = String(rawInput.status || "").trim();
        return { units: detail.units.filter((unit) => (!kind || unit.kind === kind) && (!status || unit.status === status)) };
    }
    if (name === "project_list_voices") return listVoiceProfiles();
    if (name === "project_bind_character_voice") {
        const { projectId: _projectId, assetId: _assetId, ...voice } = rawInput;
        return bindProjectCharacterVoice(projectId, String(_assetId || ""), voice as Parameters<typeof bindProjectCharacterVoice>[2]);
    }
    if (name === "project_extract_asset_candidates") {
        const candidates = Array.isArray(rawInput.candidates) ? rawInput.candidates : [];
        return createProjectAssetCandidates(projectId, candidates.map(normalizeAgentCandidateInput).filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate)), "agent");
    }
    if (name === "project_confirm_asset_candidate") {
        return confirmProjectAssetCandidate(projectId, String(rawInput.candidateId || ""), String(rawInput.assetId || "") || undefined);
    }
    if (name === "project_create_or_update_shots") {
        const shots = Array.isArray(rawInput.shots) ? rawInput.shots : [];
        const result = [];
        for (const shot of shots) {
            if (!isShotInput(shot)) continue;
            result.push((await saveProjectShot(projectId, shot)).shot);
        }
        return { shots: result };
    }
    if (name === "project_link_shot_asset") {
        return linkShotAsset(projectId, String(rawInput.shotId || ""), { assetVersionId: String(rawInput.assetVersionId || ""), role: String(rawInput.role || "reference") as ShotAssetReference["role"] });
    }
    if (name === "project_start_workflow_step") {
        return updateWorkflowStep(projectId, String(rawInput.stepId || ""), { status: "running" });
    }
    if (name === "project_link_asset") {
        return linkProjectAsset(projectId, { assetId: String(rawInput.assetId || ""), category: normalizeAssetCategory(rawInput.category) });
    }
    if (name === "project_upsert_asset_version") {
        return createProjectAssetVersion(projectId, String(rawInput.assetId || ""), { prompt: String(rawInput.prompt || ""), definitionJson: typeof rawInput.definitionJson === "string" ? rawInput.definitionJson : undefined, note: String(rawInput.note || "") });
    }
    if (name === "project_register_task_output") {
        return registerProjectTaskOutput(projectId, String(rawInput.stepId || ""), { taskId: String(rawInput.taskId || ""), assetVersionId: String(rawInput.assetVersionId || "") || undefined, resourceId: String(rawInput.resourceId || "") || undefined, mediaType: String(rawInput.mediaType || "") || undefined, role: String(rawInput.role || "output"), metadataJson: typeof rawInput.metadataJson === "string" ? rawInput.metadataJson : undefined, outputJson: typeof rawInput.outputJson === "string" ? rawInput.outputJson : undefined });
    }
    throw new Error(`未知项目工具：${name}`);
}

async function runScriptProjectBootstrap(input: Record<string, unknown>) {
    const operationId = String(input.clientOperationId || "").trim();
    const title = String(input.title || "").trim();
    const script = String(input.script || "").trim();
    const chapterTitle = String(input.chapterTitle || title).trim();
    const aspectRatio = String(input.aspectRatio || "9:16");
    const createNewCanvas = input.createNewCanvas === true;
    const requestedCanvasId = createNewCanvas ? "" : String(input.canvasId || "").trim();
    if (!operationId || !title || !script || !chapterTitle) throw new Error("clientOperationId、title、script 和 chapterTitle 均不能为空");
    if (!["9:16", "16:9", "1:1"].includes(aspectRatio)) throw new Error(`不支持的 aspectRatio：${aspectRatio}`);
    const fingerprint = await bootstrapFingerprint({ title, script, chapterTitle, aspectRatio, createNewCanvas });
    // Temporary description marker recovers a committed createProject whose response timed out.
    const markerPrefix = `agent-project-bootstrap:${operationId}:`;
    const marker = `${markerPrefix}${fingerprint}`;
    let saved = await getAgentProjectBootstrap(operationId);
    if (saved && saved.fingerprint !== fingerprint) throw new Error("clientOperationId 已用于不同的项目输入；请为新项目使用新的 ID");

    if (!saved) {
        const { projects } = await listProjects();
        const operationMatches = projects.map(({ project }) => project).filter((project) => project.description?.startsWith(markerPrefix));
        const recovered = operationMatches.filter((project) => project.description === marker);
        if (operationMatches.length && !recovered.length) throw new Error("clientOperationId 已用于不同的项目输入；请为新项目使用新的 ID");
        if (recovered.length > 1) throw new Error("发现多个使用该 clientOperationId 的项目，已停止避免重复或误绑定");
        let project = recovered[0];
        if (project && (project.name !== title || project.type !== "short-drama" || project.aspectRatio !== aspectRatio || project.sourceType !== "text")) {
            throw new Error("找到的幂等项目记录与本次输入不一致，已停止避免复用其他项目");
        }
        if (!project) {
            ({ project } = await createProject({ name: title, type: "short-drama", aspectRatio, sourceType: "text", description: marker }));
        }
        saved = { fingerprint, projectId: project.id };
        await saveAgentProjectBootstrap(operationId, saved);
    }

    const detail = await getProject(saved.projectId);
    if (detail.project.name !== title || detail.project.type !== "short-drama" || detail.project.aspectRatio !== aspectRatio) {
        throw new Error("幂等记录指向的项目与本次输入不一致，已停止避免误用");
    }
    const chapterHtml = plainTextToHtml(script);
    let chapter = saved.chapterId ? detail.units.find((unit) => unit.id === saved!.chapterId) : undefined;
    if (chapter && (chapter.kind !== "chapter" || chapter.title !== chapterTitle || chapter.sourceText !== chapterHtml)) {
        throw new Error("幂等记录中的章节与本次剧本不一致，已停止避免覆盖用户内容");
    }
    if (!chapter) {
        const matches = detail.units.filter((unit) => unit.kind === "chapter" && unit.title === chapterTitle && unit.sourceText === chapterHtml);
        if (matches.length > 1) throw new Error("项目中存在多个完全相同的剧本章节，已停止避免误选");
        chapter = matches[0];
    }
    if (!chapter) chapter = (await createProjectUnit(saved.projectId, { kind: "chapter", title: chapterTitle, sourceText: chapterHtml, position: 0 })).unit;
    saved = { ...saved, chapterId: chapter.id };
    await saveAgentProjectBootstrap(operationId, saved);

    const canvases = await listAgentCanvasProjects();
    let canvas = saved.canvasId ? canvases.find((item) => item.id === saved!.canvasId) : undefined;
    if (saved.canvasId && !canvas) throw new Error(`幂等记录中的本地画布不存在：${saved.canvasId}`);
    if (canvas && requestedCanvasId && canvas.id !== requestedCanvasId) throw new Error("此 clientOperationId 已绑定到另一张画布");
    if (!canvas && requestedCanvasId) {
        const current = canvases.find((item) => item.id === requestedCanvasId);
        if (!current) throw new Error(`当前画布未在本机列表中：${requestedCanvasId}`);
        if (current.domainProjectId && current.domainProjectId !== saved.projectId) throw new Error("当前画布已关联其他短剧项目；已停止避免覆盖关联");
        canvas = current.domainProjectId === saved.projectId ? current : await bindAgentCanvasProject({
            id: current.id,
            expectedRevision: current.revision,
            expectedUpdatedAt: current.updatedAt,
            expectedContentHash: current.contentHash,
            domainProjectId: saved.projectId,
        });
    }
    if (!canvas) {
        const matches = canvases.filter((item) => item.domainProjectId === saved!.projectId && item.title === title);
        if (matches.length > 1) throw new Error("项目下有多张同名画布，已停止避免误选");
        canvas = matches[0] || await createAgentCanvasProject({ title, domainProjectId: saved.projectId });
    }
    saved = { ...saved, canvasId: canvas.id };
    await saveAgentProjectBootstrap(operationId, saved);

    // domainProjectId on the local canvas snapshot is only a browser binding.
    // ProductionRun resolves canvas ownership from the backend canvas_unit_links table.
    await ensureBackendCanvasProjectLink(saved.projectId, canvas.id, detail.canvasUnitLinks);

    if (detail.project.description === marker) await updateProject(saved.projectId, { description: "" });
    return {
        projectId: saved.projectId,
        chapterId: chapter.id,
        canvas,
        nextTools: [
            { name: "project_get_context", input: { projectId: saved.projectId } },
            { name: "film_list_operations", input: { projectId: saved.projectId, canvasId: canvas.id } },
            { name: "film_list_models", input: { projectId: saved.projectId, canvasId: canvas.id } },
        ],
    };
}

export async function ensureBackendCanvasProjectLink(
    projectId: string,
    canvasId: string,
    existingLinks: CanvasUnitLink[],
    link = linkCanvasUnit,
) {
    if (existingLinks.some((item) => item.canvasId === canvasId)) return;
    await link(projectId, { canvasId, role: "project" });
}

async function bootstrapFingerprint(value: Record<string, unknown>) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function plainTextToHtml(value: string) {
    return value.split(/\r?\n/).map((line) => `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") || "<br>"}</p>`).join("");
}

const agentCandidateCategories = new Set<AssetCategory>(["environment", "prop", "material", "other"]);

function normalizeAgentCandidateInput(value: unknown): { unitId?: string; shotId?: string; name: string; category: AssetCategory; details?: Record<string, unknown> } | null {
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    if (typeof item.name !== "string" || typeof item.category !== "string") return null;
    const category = normalizeAssetCategory(item.category);
    if (!agentCandidateCategories.has(category)) return null;
    return {
        name: item.name,
        category,
        ...(typeof item.unitId === "string" ? { unitId: item.unitId } : {}),
        ...(typeof item.shotId === "string" ? { shotId: item.shotId } : {}),
        ...(item.details && typeof item.details === "object" && !Array.isArray(item.details) ? { details: item.details as Record<string, unknown> } : {}),
    };
}

function isShotInput(value: unknown): value is { id?: string; unitId?: string; title: string; description?: string; position?: number; durationMs?: number; status?: string } {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    return typeof item.title === "string";
}

export type ProjectAgentContext = ProjectDetail;
