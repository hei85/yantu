import {
    getSkillFile,
    listAddedSkills,
    listSkillFiles,
    type Skill,
    type SkillPackageFile,
} from "@/services/api/skills";
import { getActiveUserScope } from "@/lib/user-scope";

export const agentRuntimeToolNames = [
    "skill_catalog",
    "skill_search",
    "skill_read",
    "skill_prepare",
] as const;

export type AgentRuntimeToolName = (typeof agentRuntimeToolNames)[number];

export function isAgentRuntimeToolName(value: string): value is AgentRuntimeToolName {
    return agentRuntimeToolNames.includes(value as AgentRuntimeToolName);
}

export function isAgentRuntimeReadTool(value: string) {
    return isAgentRuntimeToolName(value);
}

type CatalogEntry = {
    skillId: string;
    name: string;
    description: string;
    versionId: string;
    version: string;
    contentHash: string;
    sourceType: string;
    enabled: true;
    autoInvokePolicy: "allowed" | "explicit_only";
    applicablePhases: string[];
    dependencySummary: string[];
    entryReadable: boolean;
    updatedAt: string;
};

type SkillPrepareInput = {
    prompt: string;
    phase?: string;
    selectedSkillIds?: string[];
    catalogRevision?: string;
    maxCharsPerSkill?: number;
    availableToolNames?: string[];
};

type LoadedSkill = {
    skill: Skill;
    entry: string;
    entryHash: string;
    entryComplete: boolean;
    entryNextOffset?: number;
    files: Array<{ path: string; content: string; sha256: string; complete: boolean; nextOffset?: number }>;
    requiredReads: string[];
    unreadRequiredFiles: string[];
    unavailableRequiredFiles: string[];
    fileListingComplete: boolean;
    fileListingError?: string;
    toolMappings: Array<{ name: string; available: boolean | null }>;
    missingToolNames: string[];
};

let catalogCache: { scope: string; revision: string; entries: CatalogEntry[]; expiresAt: number } | null = null;
export type PreparedFilmSkillEvidence = { skillId: string; versionId: string; contentHash: string; phase: string };
let preparedFilmSkillEvidenceScope = "";
const preparedFilmSkillEvidence = new Map<string, PreparedFilmSkillEvidence>();
const maxSkillsPerPhase = 4;

export function getPreparedFilmSkillEvidence(): PreparedFilmSkillEvidence[] {
    const scope = getActiveUserScope();
    if (preparedFilmSkillEvidenceScope !== scope) {
        preparedFilmSkillEvidence.clear();
        preparedFilmSkillEvidenceScope = scope;
    }
    return [...preparedFilmSkillEvidence.values()];
}

export async function runAgentRuntimeTool(name: AgentRuntimeToolName, rawInput: Record<string, unknown>) {
    if (name === "skill_catalog") return skillCatalog(rawInput);
    if (name === "skill_search") return skillSearch(rawInput);
    if (name === "skill_read") return skillRead(rawInput);
    if (name === "skill_prepare") return prepareFilmSkillEvidence(rawInput as unknown as SkillPrepareInput);
    throw new Error(`未知 Agent Runtime 工具：${name}`);
}

async function prepareFilmSkillEvidence(input: SkillPrepareInput) {
    const result = await skillPrepare(input);
    const scope = getActiveUserScope();
    if (preparedFilmSkillEvidenceScope !== scope) {
        preparedFilmSkillEvidence.clear();
        preparedFilmSkillEvidenceScope = scope;
    }
    const phase = String(input.phase || "planning").trim();
    for (const [key, evidence] of preparedFilmSkillEvidence) {
        if (evidence.phase === phase) preparedFilmSkillEvidence.delete(key);
    }
    if (result.readyForUse) {
        for (const selected of result.selected) {
            if (!selected.skillId || !selected.versionId || !selected.contentHash) continue;
            const evidence = { skillId: selected.skillId, versionId: selected.versionId, contentHash: selected.contentHash, phase };
            preparedFilmSkillEvidence.set(`${phase}\u0000${selected.skillId}`, evidence);
        }
    }
    return result;
}

async function skillCatalog(rawInput: Record<string, unknown>) {
    const entries = await loadCatalog();
    const page = clampInt(rawInput.page, 1, 10_000, 1);
    const pageSize = clampInt(rawInput.pageSize, 1, 80, 30);
    const query = String(rawInput.query || "").trim().toLocaleLowerCase();
    const phase = String(rawInput.phase || "").trim().toLocaleLowerCase();
    const filtered = entries.filter((entry) => {
        if (phase && !entry.applicablePhases.some((item) => skillPhasesMatch(item, phase))) return false;
        if (!query) return true;
        return `${entry.name}\n${entry.description}`.toLocaleLowerCase().includes(query);
    });
    const start = (page - 1) * pageSize;
    return {
        catalogRevision: catalogCache?.revision || "",
        total: filtered.length,
        hasMore: start + pageSize < filtered.length,
        nextPage: start + pageSize < filtered.length ? page + 1 : null,
        skills: filtered.slice(start, start + pageSize),
        guidance: [
            "库中安装但未用户启用的技能不会出现在目录中。",
            "catalog 只返回摘要；执行前用 skill_read 或 skill_prepare 读取完整入口。",
        ],
    };
}

async function skillSearch(rawInput: Record<string, unknown>) {
    const query = String(rawInput.query || "").trim();
    if (!query) throw new Error("缺少 query");
    const phase = String(rawInput.phase || "").trim();
    const limit = clampInt(rawInput.limit, 1, 50, 12);
    const entries = await loadCatalog();
    const scored = entries
        .map((entry) => ({ entry, score: relevanceScore(query, entry, phase) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
        .slice(0, limit);
    return {
        query,
        phase: phase || null,
        catalogRevision: catalogCache?.revision || "",
        results: scored.map(({ entry, score }) => ({ ...entry, score })),
        excluded: entries
            .filter((entry) => !scored.some((item) => item.entry.skillId === entry.skillId))
            .slice(0, limit)
            .map((entry) => ({ skillId: entry.skillId, name: entry.name, reason: "相关性不足或策略不允许自动调用" })),
    };
}

async function skillRead(rawInput: Record<string, unknown>) {
    const skillId = String(rawInput.skillId || "").trim();
    if (!skillId) throw new Error("缺少 skillId");
    const path = normalizePackagePath(String(rawInput.path || "SKILL.md"));
    const offset = clampInt(rawInput.offset, 0, 1_000_000, 0);
    const maxChars = clampInt(rawInput.maxChars, 256, 200_000, 64_000);
    const entries = await loadCatalog();
    const entry = entries.find((item) => item.skillId === skillId);
    if (!entry) throw new Error("技能不存在、未启用或不属于当前用户");
    const result = await getSkillFile(skillId, path);
    if (result.file.binary) throw new Error("该技能文件是二进制，不能用 skill_read 读取");
    const chars = Array.from(result.file.content);
    const slice = chars.slice(offset, offset + maxChars).join("");
    const nextOffset = offset + slice.length < chars.length ? offset + slice.length : undefined;
    return {
        skillId,
        name: entry.name,
        versionId: entry.versionId,
        version: entry.version,
        contentHash: entry.contentHash,
        path,
        sha256: result.file.file.sha256,
        offset,
        totalChars: chars.length,
        content: slice,
        complete: nextOffset === undefined,
        nextOffset: nextOffset ?? null,
    };
}

async function skillPrepare(input: SkillPrepareInput) {
    const prompt = String(input.prompt || "").trim();
    if (!prompt) throw new Error("缺少 prompt");
    const phase = String(input.phase || "planning").trim();
    const explicit = new Set(input.selectedSkillIds || []);
    if (explicit.size > maxSkillsPerPhase) {
        return {
            ok: false,
            readyForUse: false,
            code: "skill_phase_limit_exceeded",
            phase,
            selectionSource: "explicit",
            requestedSkillIds: [...explicit],
            selected: [],
            failureReasons: [`每个阶段最多准备 ${maxSkillsPerPhase} 个技能；已完整保留所选 ID，请由 Agent 拆分阶段准备，不会静默截断。`],
            promptContext: "",
        };
    }
    const entries = await loadCatalog();
    if (input.catalogRevision && catalogCache?.revision && input.catalogRevision !== catalogCache.revision) {
        return {
            ok: false,
            code: "catalog_revision_changed",
            catalogRevision: catalogCache.revision,
            requestedRevision: input.catalogRevision,
            message: "技能目录已变化，请重新搜索后选择。",
        };
    }

    const selected = explicit.size
        ? entries.filter((entry) => explicit.has(entry.skillId))
        : entries
            .filter((entry) => entry.autoInvokePolicy === "allowed")
            .map((entry) => ({ entry, score: relevanceScore(prompt, entry, phase) }))
            .filter((item) => item.score > 0)
            .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
            .slice(0, 4)
            .map((item) => item.entry);
    const missingExplicit = [...explicit].filter((skillId) => !selected.some((entry) => entry.skillId === skillId));
    if (missingExplicit.length) {
        return {
            ok: false,
            readyForUse: false,
            code: "explicit_skill_unavailable",
            phase,
            catalogRevision: catalogCache?.revision || "",
            selectionSource: "explicit",
            selected: [],
            missingExplicit,
            failureReasons: missingExplicit.map((skillId) => `显式指定技能不可用或未启用：${skillId}`),
            promptContext: "",
        };
    }
    const perSkillLimit = clampInt(input.maxCharsPerSkill, 1024, 200_000, 48_000);
    const availableToolNamesKnown = Array.isArray(input.availableToolNames);
    const availableToolNames = new Set((input.availableToolNames || []).filter((name) => typeof name === "string"));
    const loadedResults: Array<{ entry: CatalogEntry; loaded: LoadedSkill } | { entry: CatalogEntry; error: string }> = await Promise.all(selected.map(async (entry) => {
        try {
            return { entry, loaded: await loadSkill(entry, perSkillLimit, availableToolNames, availableToolNamesKnown) };
        } catch (error) {
            return { entry, error: error instanceof Error ? error.message : String(error) };
        }
    }));
    const loaded = loadedResults.filter((result): result is { entry: CatalogEntry; loaded: LoadedSkill } => "loaded" in result);
    const failures = loadedResults.flatMap((result) => "error" in result ? [{ skillId: result.entry.skillId, error: result.error }] : []);
    const hasUnknownToolDependencies = !availableToolNamesKnown && loaded.some(({ loaded: item }) => item.toolMappings.length > 0);
    const readyForUse = failures.length === 0 && !hasUnknownToolDependencies && loaded.every(({ loaded: item }) => item.entryComplete && item.unreadRequiredFiles.length === 0 && item.unavailableRequiredFiles.length === 0 && item.fileListingComplete && item.missingToolNames.length === 0);
    return {
        ok: readyForUse,
        readyForUse,
        phase,
        catalogRevision: catalogCache?.revision || "",
        selectionSource: explicit.size ? "explicit" : "automatic",
        selected: loaded.map(({ entry, loaded: item }) => ({
            skillId: item.skill.skillId,
            name: item.skill.skillName,
            versionId: item.skill.versionId,
            version: item.skill.version,
            contentHash: item.skill.contentHash,
            selectionEvidence: explicit.size ? { source: "explicit", phase } : { source: "automatic", phase, score: relevanceScore(prompt, entry, phase), catalogRevision: catalogCache?.revision || "" },
            entryComplete: item.entryComplete,
            entrySha256: item.entryHash,
            entryNextOffset: item.entryNextOffset ?? null,
            requiredReads: item.requiredReads,
            unreadRequiredFiles: item.unreadRequiredFiles,
            unavailableRequiredFiles: item.unavailableRequiredFiles,
            fileListingComplete: item.fileListingComplete,
            fileListingError: item.fileListingError || "",
            toolMappings: item.toolMappings,
            missingToolNames: item.missingToolNames,
            files: item.files.map((file) => ({ path: file.path, sha256: file.sha256, complete: file.complete, nextOffset: file.nextOffset ?? null })),
        })),
        missingExplicit,
        failures,
        failureReasons: [
            ...failures.map((failure) => `${failure.skillId}: ${failure.error}`),
            ...loaded.flatMap(({ loaded: item }) => [
                ...(!item.entryComplete ? [`${item.skill.skillId}/SKILL.md 尚未完整读取；从 ${item.entryNextOffset || 0} 继续`] : []),
                ...item.unreadRequiredFiles.map((path) => `${item.skill.skillId}/${path} 尚未完整读取`),
                ...item.unavailableRequiredFiles.map((path) => `${item.skill.skillId}/${path} 无法读取或是二进制文件`),
                ...item.missingToolNames.map((name) => `${item.skill.skillId} 依赖工具当前不可用：${name}`),
                ...(!availableToolNamesKnown && item.toolMappings.length ? [`${item.skill.skillId} 的工具依赖无法核验；请从已连接的 MCP 工具清单调用 skill_prepare`] : []),
                ...(!item.fileListingComplete ? [`${item.skill.skillId} 技能文件目录读取失败`] : []),
            ]),
        ],
        toolDependencyHealth: { availableToolNamesKnown, availableToolCount: availableToolNames.size, missingToolNames: [...new Set(loaded.flatMap(({ loaded: item }) => item.missingToolNames))] },
        excluded: entries
            .filter((entry) => !selected.some((item) => item.skillId === entry.skillId))
            .slice(0, 20)
            .map((entry) => ({ skillId: entry.skillId, reason: explicit.size ? "未被显式选择" : "相关性不足" })),
        promptContext: loaded.map(({ loaded: item }) => renderLoadedSkill(item)).join("\n\n"),
        guidance: [
            "readyForUse=false 时不能声称技能已准备完成；必须读取 unreadRequiredFiles/entryNextOffset，或解决依赖缺失后再继续。",
            "技能只能提供方法，不增加模型能力、工具权限或预算。",
        ],
    };
}

async function loadCatalog() {
    const scope = getActiveUserScope();
    if (catalogCache && catalogCache.scope === scope && catalogCache.expiresAt > Date.now()) return catalogCache.entries;
    const result = await listAddedSkills();
    const entries = await Promise.all(result.skills.filter((skill) => skill.isAdded).map(toCatalogEntry));
    const revision = shortHash(entries.map((entry) => `${entry.skillId}:${entry.versionId}:${entry.contentHash}`).sort().join("\n"));
    catalogCache = { scope, revision, entries, expiresAt: Date.now() + 15_000 };
    return entries;
}

async function toCatalogEntry(skill: Skill): Promise<CatalogEntry> {
    let entry = "";
    let entryReadable = true;
    try {
        const file = await getSkillFile(skill.skillId, "SKILL.md");
        entry = file.file.binary ? "" : file.file.content;
    } catch {
        entryReadable = false;
    }
    const metadata = parseSkillMetadata(entry);
    return {
        skillId: skill.skillId,
        name: skill.skillName,
        description: skill.description,
        versionId: skill.versionId,
        version: skill.version,
        contentHash: skill.contentHash,
        sourceType: skill.sourceType,
        enabled: true,
        autoInvokePolicy: metadata.allowImplicitInvocation ? "allowed" : "explicit_only",
        applicablePhases: metadata.phases.length ? metadata.phases : inferPhases(`${skill.skillName} ${skill.description} ${entry}`),
        dependencySummary: metadata.dependencies,
        entryReadable,
        updatedAt: skill.updatedAt,
    };
}

async function loadSkill(entry: CatalogEntry, maxChars: number, availableToolNames: Set<string>, availableToolNamesKnown: boolean): Promise<LoadedSkill> {
    const skill = (await listAddedSkills()).skills.find((item) => item.skillId === entry.skillId);
    if (!skill) throw new Error(`技能 ${entry.skillId} 已不可用`);
    const entryFile = await getSkillFile(skill.skillId, "SKILL.md");
    if (entryFile.file.binary) throw new Error(`${entry.skillId}/SKILL.md 是二进制文件`);
    let files: SkillPackageFile[] = [];
    let fileListingError = "";
    try {
        files = (await listSkillFiles(skill.skillId)).files;
    } catch (error) {
        fileListingError = error instanceof Error ? error.message : String(error);
    }
    const entryChars = Array.from(entryFile.file.content);
    const entrySlice = entryChars.slice(0, maxChars).join("");
    const entryComplete = entrySlice.length === entryChars.length;
    const requiredReads: string[] = [];
    const loadedFiles: LoadedSkill["files"] = [];
    const unreadRequiredFiles: string[] = [];
    const unavailableRequiredFiles: string[] = [];
    let remaining = Math.max(0, maxChars - entrySlice.length);
    const pendingReads = referencedFiles(entryFile.file.content, files);
    const visitedReads = new Set<string>();
    while (pendingReads.length) {
        const path = pendingReads.shift()!;
        if (visitedReads.has(path)) continue;
        visitedReads.add(path);
        requiredReads.push(path);
        if (remaining <= 0) {
            unreadRequiredFiles.push(path);
            continue;
        }
        let file: Awaited<ReturnType<typeof getSkillFile>>;
        try {
            file = await getSkillFile(skill.skillId, path);
        } catch {
            unavailableRequiredFiles.push(path);
            continue;
        }
        if (file.file.binary) {
            unavailableRequiredFiles.push(path);
            continue;
        }
        const chars = Array.from(file.file.content);
        const content = chars.slice(0, remaining).join("");
        const contentLength = Array.from(content).length;
        const complete = contentLength === chars.length;
        loadedFiles.push({
            path,
            content,
            sha256: file.file.file.sha256,
            complete,
            ...(complete ? {} : { nextOffset: contentLength }),
        });
        remaining -= contentLength;
        if (!complete) unreadRequiredFiles.push(path);
        for (const nestedPath of referencedFiles(file.file.content, files)) {
            if (!visitedReads.has(nestedPath)) pendingReads.push(nestedPath);
        }
    }
    const referencedToolNames = [...new Set(Array.from(`${entryFile.file.content}\n${loadedFiles.map((file) => file.content).join("\n")}`.matchAll(/\b(?:canvas|film|project|skill)_[a-z0-9_]+\b/g), (match) => match[0]))].sort();
    const toolMappings = referencedToolNames.map((name) => ({ name, available: availableToolNamesKnown ? availableToolNames.has(name) : null }));
    const missingToolNames = toolMappings.filter((item) => item.available === false).map((item) => item.name);
    return {
        skill,
        entry: entrySlice,
        entryHash: entryFile.file.file.sha256,
        entryComplete,
        ...(entryComplete ? {} : { entryNextOffset: entrySlice.length }),
        files: loadedFiles,
        requiredReads,
        unreadRequiredFiles,
        unavailableRequiredFiles,
        fileListingComplete: !fileListingError,
        fileListingError,
        toolMappings,
        missingToolNames,
    };
}

function renderLoadedSkill(loaded: LoadedSkill) {
    const files = [
        `<skill-file path="SKILL.md" sha256="${escapeAttribute(loaded.entryHash)}" complete="${loaded.entryComplete}">\n${loaded.entry}\n</skill-file>`,
        ...loaded.files.map((file) => `<skill-file path="${escapeAttribute(file.path)}" sha256="${escapeAttribute(file.sha256)}" complete="${file.complete}">\n${file.content}\n</skill-file>`),
    ];
    return `<skill-context skill-id="${escapeAttribute(loaded.skill.skillId)}" name="${escapeAttribute(loaded.skill.skillName)}" version="${escapeAttribute(loaded.skill.version)}">\n${files.join("\n")}\n</skill-context>`;
}

function parseSkillMetadata(entry: string) {
    const frontmatter = entry.match(/^---\n([\s\S]*?)\n---/)?.[1] || "";
    const allowImplicitInvocation = !/(?:allow_implicit_invocation|allow-implicit-invocation)\s*:\s*false/i.test(frontmatter);
    const phases = frontmatter
        .split("\n")
        .filter((line) => /(?:phase|stage|阶段)/i.test(line))
        .flatMap((line) => line.split(/[:,]/).slice(1))
        .map((item) => item.trim().replace(/^['"]|['"]$/g, "").toLocaleLowerCase())
        .filter(Boolean);
    const dependencies = entry
        .split("\n")
        .filter((line) => /(?:依赖|requires?|tools?|mcp)/i.test(line))
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 12);
    return { allowImplicitInvocation, phases, dependencies };
}

function referencedFiles(entry: string, files: SkillPackageFile[]) {
    const known = new Set(files.map((file) => normalizePackagePath(file.path)));
    const matches = Array.from(entry.matchAll(/`([^`\n]+)`/g)).flatMap((match) => {
        try {
            const path = normalizePackagePath(match[1]);
            return known.has(path) && path !== "SKILL.md" ? [path] : [];
        } catch {
            return [];
        }
    });
    return [...new Set(matches)];
}

function relevanceScore(query: string, entry: CatalogEntry, phase: string) {
    const terms = searchTerms(query);
    const text = `${entry.name} ${entry.description}`.toLocaleLowerCase();
    let score = terms.reduce((total, term) => total + (text.includes(term) ? term.length : 0), 0);
    if (phase) {
        const phaseMatch = entry.applicablePhases.some((item) => skillPhasesMatch(item, phase));
        if (phaseMatch) score += 8;
        else score -= 2;
    }
    return score;
}

function skillPhasesMatch(available: string, requested: string) {
    const availablePhase = canonicalSkillPhase(available);
    const requestedPhase = canonicalSkillPhase(requested);
    if (!availablePhase || !requestedPhase) return false;
    return availablePhase === requestedPhase || availablePhase.includes(requestedPhase) || requestedPhase.includes(availablePhase);
}

function canonicalSkillPhase(value: string) {
    const phase = value.trim().toLocaleLowerCase().replace(/[\s_-]+/g, " ");
    if (["continuity", "character continuity", "visual continuity"].includes(phase)) return "consistency";
    if (["qa", "quality assurance", "quality check"].includes(phase)) return "verification";
    if (["shot list", "shotlist", "shot planning"].includes(phase)) return "storyboard";
    return phase;
}

function inferPhases(value: string) {
    const text = value.toLocaleLowerCase();
    const phases: string[] = [];
    if (/分镜|storyboard|镜头|导演/.test(text)) phases.push("planning", "storyboard");
    if (/角色|人物|一致性|character|continuity/.test(text)) phases.push("casting", "consistency");
    if (/声音|配音|音频|voice|audio|字幕/.test(text)) phases.push("audio");
    if (/剪辑|时间线|渲染|timeline|edit|render/.test(text)) phases.push("editing", "rendering");
    if (/验收|检查|quality|verify/.test(text)) phases.push("verification");
    return phases.length ? [...new Set(phases)] : ["planning"];
}

function searchTerms(value: string) {
    const normalized = value.toLocaleLowerCase();
    const terms = new Set(normalized.match(/[a-z0-9_-]{2,}/g) || []);
    const chinese = Array.from(normalized.replace(/[^\p{Script=Han}]/gu, ""));
    for (let index = 0; index < chinese.length - 1; index += 1) terms.add(`${chinese[index]}${chinese[index + 1]}`);
    return [...terms].slice(0, 80);
}

function normalizePackagePath(value: string) {
    const normalized = value.trim().replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error("技能文件路径无效");
    }
    return normalized;
}

function shortHash(value: string) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.round(parsed)));
}

function escapeAttribute(value: string) {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
