import { buildCanvasProjectsZip } from "@/lib/canvas/canvas-export";
import { importCanvasProjectArchive } from "@/lib/canvas/canvas-project-archive";
import { CANVAS_STORE_KEY, flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { parseCanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { listProjects } from "@/services/api/projects";
import { deleteLocalCanvasProjects } from "@/services/local-canvas-projects";
import { useAssetStore } from "@/stores/use-asset-store";
import { saveAs } from "file-saver";

const AGENT_PROJECT_BOOTSTRAP_KEY = "canvas-agent-project-bootstrap-v1";
export type AgentProjectBootstrap = { fingerprint: string; projectId: string; chapterId?: string; canvasId?: string };

export async function getAgentProjectBootstrap(operationId: string): Promise<AgentProjectBootstrap | null> {
    const stored = await localForageStorageForScope(getActiveUserScope()).getItem(AGENT_PROJECT_BOOTSTRAP_KEY);
    if (!stored) return null;
    let records: unknown;
    try { records = JSON.parse(stored); } catch { return null; }
    if (!records || typeof records !== "object" || Array.isArray(records)) return null;
    const value = (records as Record<string, unknown>)[operationId];
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (typeof item.fingerprint !== "string" || typeof item.projectId !== "string") return null;
    return { fingerprint: item.fingerprint, projectId: item.projectId, ...(typeof item.chapterId === "string" ? { chapterId: item.chapterId } : {}), ...(typeof item.canvasId === "string" ? { canvasId: item.canvasId } : {}) };
}

export async function saveAgentProjectBootstrap(operationId: string, value: AgentProjectBootstrap) {
    const storage = localForageStorageForScope(getActiveUserScope());
    const stored = await storage.getItem(AGENT_PROJECT_BOOTSTRAP_KEY);
    let records: Record<string, unknown> = {};
    try {
        const parsed: unknown = stored ? JSON.parse(stored) : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records = parsed as Record<string, unknown>;
    } catch { /* Replace a corrupt bootstrap index with a valid record. */ }
    await storage.setItem(AGENT_PROJECT_BOOTSTRAP_KEY, JSON.stringify({ ...records, [operationId]: value }));
    const durable = await storage.getItem(AGENT_PROJECT_BOOTSTRAP_KEY);
    let parsed: Record<string, unknown> | null = null;
    try { parsed = durable ? JSON.parse(durable) as Record<string, unknown> : null; } catch { /* validated below */ }
    const saved = parsed?.[operationId] as AgentProjectBootstrap | undefined;
    if (saved?.projectId !== value.projectId || saved.fingerprint !== value.fingerprint) throw new Error("短剧项目创建记录尚未保存到本机");
}

function requiredId(value: string, label: string) {
    const id = value.trim();
    if (!id) throw new Error(`${label}不能为空`);
    return id;
}

async function projectContentHash(project: CanvasProject) {
    const bytes = new TextEncoder().encode(JSON.stringify(project));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireVersion(project: CanvasProject, expectedRevision: number, expectedUpdatedAt: string, expectedContentHash: string) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("expectedRevision 必须是非负整数");
    if (!expectedUpdatedAt) throw new Error("expectedUpdatedAt 不能为空");
    if (!/^[a-f0-9]{64}$/.test(expectedContentHash)) throw new Error("expectedContentHash 必须是从最新画布列表读取的 SHA-256");
    const serialized = JSON.stringify(project);
    const actualHash = await projectContentHash(project);
    // Hashing yields to the browser. A user action in that interval must invalidate this check.
    if (JSON.stringify(findCanvasProject(project.id)) !== serialized) throw new Error(`画布「${project.title}」在校验期间发生变化，请重新读取画布列表`);
    if ((project.revision ?? 0) !== expectedRevision || project.updatedAt !== expectedUpdatedAt) {
        throw new Error(`画布版本已变化：expectedRevision=${expectedRevision}，actualRevision=${project.revision ?? "unknown"}，expectedUpdatedAt=${expectedUpdatedAt}，actualUpdatedAt=${project.updatedAt}`);
    }
    if (actualHash !== expectedContentHash) throw new Error(`画布「${project.title}」内容已变化，请重新读取画布列表`);
}

function findCanvasProject(id: string) {
    const project = useCanvasStore.getState().projects.find((item) => item.id === id);
    if (!project) throw new Error(`画布不存在：${id}`);
    return project;
}

async function findDurableCanvasProject(id: string) {
    const serialized = await localForageStorageForScope(getActiveUserScope()).getItem(CANVAS_STORE_KEY);
    const project = parseCanvasStorageDocument(serialized).state.projects.find((item) => item.id === id);
    if (!project) throw new Error(`画布尚未保存到本机：${id}`);
    return project;
}

async function projectSummary(project: CanvasProject) {
    return {
        id: project.id,
        title: project.title,
        domainProjectId: project.projectId ?? null,
        revision: project.revision ?? 0,
        updatedAt: project.updatedAt,
        createdAt: project.createdAt,
        nodeCount: project.nodes.length,
        connectionCount: project.connections.length,
        hasTimeline: Boolean(project.timeline),
        contentHash: await projectContentHash(project),
    };
}

export async function listAgentCanvasProjects() {
    return Promise.all(useCanvasStore.getState().projects.map(projectSummary));
}

async function requireDomainProject(projectId: string) {
    const id = requiredId(projectId, "domainProjectId");
    const { projects } = await listProjects();
    if (!projects.some(({ project }) => project.id === id)) throw new Error(`短剧项目不存在或不可访问：${id}`);
    return id;
}

export async function createAgentCanvasProject(input: { title: string; domainProjectId?: string }) {
    const title = input.title.trim();
    if (!title) throw new Error("title 不能为空");
    const domainProjectId = input.domainProjectId ? await requireDomainProject(input.domainProjectId) : undefined;
    const id = useCanvasStore.getState().createProject(title, domainProjectId);
    await flushCanvasStorePersistence();
    const durable = await findDurableCanvasProject(id);
    if (durable.title !== title || durable.projectId !== domainProjectId) throw new Error("新建画布的本地保存结果与请求不一致");
    return projectSummary(findCanvasProject(id));
}

export async function renameAgentCanvasProject(input: { id: string; expectedRevision: number; expectedUpdatedAt: string; expectedContentHash: string; title: string }) {
    const id = requiredId(input.id, "canvasId");
    const project = findCanvasProject(id);
    await requireVersion(project, input.expectedRevision, input.expectedUpdatedAt, input.expectedContentHash);
    const title = input.title.trim();
    if (!title) throw new Error("title 不能为空");
    useCanvasStore.getState().renameProject(id, title);
    await flushCanvasStorePersistence();
    if ((await findDurableCanvasProject(id)).title !== title) throw new Error("画布重命名尚未保存到本机");
    return projectSummary(findCanvasProject(id));
}

export async function bindAgentCanvasProject(input: { id: string; expectedRevision: number; expectedUpdatedAt: string; expectedContentHash: string; domainProjectId: string | null }) {
    const id = requiredId(input.id, "canvasId");
    const project = findCanvasProject(id);
    await requireVersion(project, input.expectedRevision, input.expectedUpdatedAt, input.expectedContentHash);
    const domainProjectId = input.domainProjectId === null ? undefined : await requireDomainProject(input.domainProjectId);
    await requireVersion(findCanvasProject(id), input.expectedRevision, input.expectedUpdatedAt, input.expectedContentHash);
    useCanvasStore.getState().updateProject(id, { projectId: domainProjectId });
    await flushCanvasStorePersistence();
    if ((await findDurableCanvasProject(id)).projectId !== domainProjectId) throw new Error("画布项目关联尚未保存到本机");
    return projectSummary(findCanvasProject(id));
}

export async function importAgentCanvasProjectArchive(input: { file: Blob; preferLocal?: boolean; onProgress?: (completed: number, total: number) => void }) {
    if (!(input.file instanceof Blob)) throw new Error("file 必须是浏览器中的 File 或 Blob");
    return importCanvasProjectArchive(input.file, { preferLocal: input.preferLocal, onProgress: input.onProgress });
}

export async function deleteAgentCanvasProjects(input: { projects: Array<{ id: string; expectedRevision: number; expectedUpdatedAt: string; expectedContentHash: string }> }) {
    if (!Array.isArray(input.projects) || input.projects.length === 0) throw new Error("必须提供明确的待删除画布 ID 和版本");
    const ids = input.projects.map(({ id }) => requiredId(id, "canvasId"));
    if (new Set(ids).size !== ids.length) throw new Error("待删除画布 ID 不能重复");
    const currentCanvasId = typeof window !== "undefined" ? /^\/canvas\/([^/?#]+)/.exec(window.location.pathname)?.[1] : undefined;
    if (currentCanvasId && ids.includes(decodeURIComponent(currentCanvasId))) throw new Error("当前正在编辑的画布不能删除，请先离开该画布");
    const snapshots = input.projects.map((item) => ({ id: requiredId(item.id, "canvasId"), serialized: JSON.stringify(findCanvasProject(item.id)) }));
    for (const item of input.projects) await requireVersion(findCanvasProject(requiredId(item.id, "canvasId")), item.expectedRevision, item.expectedUpdatedAt, item.expectedContentHash);
    for (const snapshot of snapshots) {
        if (JSON.stringify(findCanvasProject(snapshot.id)) !== snapshot.serialized) throw new Error(`画布 ${snapshot.id} 在删除前发生变化，请重新读取画布列表`);
    }
    await deleteLocalCanvasProjects(ids);
    const remainingIds = useCanvasStore.getState().projects.filter(({ id }) => ids.includes(id)).map(({ id }) => id);
    if (remainingIds.length) throw new Error(`部分画布删除后仍存在：${remainingIds.join(", ")}`);
    const serialized = await localForageStorageForScope(getActiveUserScope()).getItem(CANVAS_STORE_KEY);
    const durableRemaining = parseCanvasStorageDocument(serialized).state.projects.filter(({ id }) => ids.includes(id)).map(({ id }) => id);
    if (durableRemaining.length) throw new Error(`部分画布未从本机存储删除：${durableRemaining.join(", ")}`);
    void useAssetStore.getState().cleanupImages();
    return { deletedIds: ids, remainingIds };
}

export async function exportAgentCanvasProjects(input: { projectIds: string[]; expectedRevisions: Record<string, { revision: number; updatedAt: string; contentHash: string }> }) {
    if (!Array.isArray(input.projectIds) || !input.projectIds.length) throw new Error("必须提供明确的画布 ID 列表");
    const ids = input.projectIds.map((id) => requiredId(id, "canvasId"));
    if (new Set(ids).size !== ids.length) throw new Error("画布 ID 不能重复");
    const projects = await Promise.all(ids.map(async (id) => {
        const project = findCanvasProject(id);
        const expected = input.expectedRevisions?.[id];
        if (!expected) throw new Error(`缺少画布版本前置条件：${id}`);
        await requireVersion(project, expected.revision, expected.updatedAt, expected.contentHash);
        return structuredClone(project);
    }));
    const blob = await buildCanvasProjectsZip(projects);
    for (const project of projects) {
        const current = findCanvasProject(project.id);
        const expected = input.expectedRevisions[project.id];
        await requireVersion(current, expected.revision, expected.updatedAt, expected.contentHash);
        if (JSON.stringify(current) !== JSON.stringify(project)) throw new Error(`画布「${project.title}」在导出期间发生变化，请重新读取后重试`);
    }
    return {
        blob,
        mimeType: "application/zip" as const,
        fileName: `画布-${projects.length}个画布.zip`,
        projectIds: projects.map(({ id }) => id),
        projectRevisions: Object.fromEntries(projects.map(({ id, revision }) => [id, revision ?? null])),
        bytes: blob.size,
    };
}

export async function downloadAgentCanvasProjects(input: { projectIds: string[]; expectedRevisions: Record<string, { revision: number; updatedAt: string; contentHash: string }> }) {
    const archive = await exportAgentCanvasProjects(input);
    saveAs(archive.blob, archive.fileName);
    return {
        fileName: archive.fileName,
        mimeType: archive.mimeType,
        bytes: archive.bytes,
        projectIds: archive.projectIds,
        projectRevisions: archive.projectRevisions,
        delivery: "browser-download" as const,
    };
}
