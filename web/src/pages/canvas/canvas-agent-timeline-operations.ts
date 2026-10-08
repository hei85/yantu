import { nanoid } from "nanoid";
import { canonicalize } from "json-canonicalize";

import { CANVAS_STORE_KEY, flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { parseCanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { buildTimelineFromNodes } from "@/lib/timeline/timeline-build";
import { getTimelineVisualEndMs } from "@/lib/timeline/timeline-view";
import { canPlaceAt } from "@/lib/timeline/timeline-placement";
import { DEFAULT_SUBTITLE_TRACK_ID } from "@/lib/timeline/timeline-tracks";
import { remapHighlightsAfterResegment } from "@/lib/timeline/subtitle-highlights";
import { timelineOverlayRect } from "@/lib/timeline/timeline-overlay";
import { getMediaBlob, resolveMediaUrl } from "@/services/file-storage";
import type { SrtEntry, SubtitleHighlight, TimelineClip, TimelineProject, TimelineTrack } from "@/types/timeline";

const MIN_CLIP_DURATION_MS = 100;

export type CanvasAgentTimelineSnapshot = {
    projectId: string;
    expectedHash: string;
    timeline: TimelineProject;
    projectUpdatedAt: string;
};

export type CanvasAgentTimelineOperation =
    | { type: "clip.insert"; clip: TimelineClip }
    | { type: "clip.move"; clipId: string; startMs: number; trackId?: string }
    | { type: "clip.trim"; clipId: string; edge: "left" | "right"; deltaMs: number }
    | { type: "clip.split"; clipId: string; atMs: number }
    | { type: "clip.delete"; clipId: string }
    | { type: "clip.setOverlay"; clipId: string; overlay: NonNullable<TimelineClip["overlay"]> | null }
    | { type: "subtitle.create"; nodeId: string; startMs: number; durationMs: number; text: string; trackId?: string }
    | { type: "subtitle.update"; clipId: string; patch: { startMs?: number; durationMs?: number; text?: string } }
    | { type: "subtitle.delete"; clipId: string }
    | { type: "track.create"; kind: TimelineTrack["kind"]; label?: string }
    | { type: "track.update"; trackId: string; patch: { label?: string } }
    | { type: "track.delete"; trackId: string }
    | { type: "track.reorder"; trackIds: string[] }
    | { type: "track.setFlag"; trackId: string; flag: "visible" | "locked" | "muted"; value: boolean }
    | { type: "clip.audioMix"; clipId: string; patch: { volume?: number; fadeInMs?: number; fadeOutMs?: number } };

/** Reusable public inputs for schema/bridge layers that mirror the operations below. */
export type CanvasAgentTrackCreateInput = Extract<CanvasAgentTimelineOperation, { type: "track.create" }>;
export type CanvasAgentTrackUpdateInput = Extract<CanvasAgentTimelineOperation, { type: "track.update" }>;
export type CanvasAgentTrackDeleteInput = Extract<CanvasAgentTimelineOperation, { type: "track.delete" }>;
export type CanvasAgentTrackReorderInput = Extract<CanvasAgentTimelineOperation, { type: "track.reorder" }>;
export type CanvasAgentTrackFlagInput = Extract<CanvasAgentTimelineOperation, { type: "track.setFlag" }>;
export type CanvasAgentClipAudioMixInput = Extract<CanvasAgentTimelineOperation, { type: "clip.audioMix" }>;

export type CanvasAgentTimelineOperationResult = {
    projectId: string;
    expectedHash: string;
    timeline: TimelineProject;
    changedClipIds: string[];
};

export type CanvasAgentTimelineNodePatch = {
    nodeId: string;
    subtitleEntries: SrtEntry[];
    subtitleHighlights: SubtitleHighlight[];
};

/** Page-owned React/store adapter; it must recheck expectedHash immediately before its synchronous store commit. */
export type CanvasAgentTimelineCommitPageState = (input: {
    projectId: string;
    expectedHash: string;
    timeline: TimelineProject;
    subtitleNodePatches: CanvasAgentTimelineNodePatch[];
}) => Promise<void>;

export function canvasAgentTimelineProjectHash(project: CanvasProject): string {
    // FNV-1a over the full serialized project. This is a stale-write token, not a security primitive.
    const value = canonicalize(project);
    let hash = 0x811c9dc5;
    let hash2 = 0x9e3779b9;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
        hash2 ^= value.charCodeAt(index) + index;
        hash2 = Math.imul(hash2, 0x85ebca6b);
    }
    return `canvas-project-fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}-${(hash2 >>> 0).toString(16).padStart(8, "0")}-${value.length}`;
}

function requireProjectId(projectId: string) {
    if (typeof projectId !== "string" || !projectId.trim()) throw new Error("时间线操作必须提供 projectId");
}

function finiteMs(value: number, label: string, minimum = 0) {
    const rounded = Math.round(value);
    if (!Number.isSafeInteger(rounded) || rounded < minimum) throw new Error(`${label} 必须是大于等于 ${minimum} 的安全整数毫秒数`);
    return rounded;
}

function assertOverlayRect(rect: NonNullable<TimelineClip["overlay"]>) {
    const values = [rect.x, rect.y, rect.width, rect.height];
    if (!values.every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > 1 || rect.y + rect.height > 1) {
        throw new Error("overlay 坐标必须在 0 到 1 之间，且矩形不得越出画面");
    }
}

function initialTimeline(project: CanvasProject): TimelineProject {
    return project.timeline || buildTimelineFromNodes(project.nodes);
}

function normalizeTimeline(timeline: TimelineProject): TimelineProject {
    const durationMs = Math.max(1_000, getTimelineVisualEndMs(timeline.clips));
    return { ...timeline, version: 2, durationMs, updatedAt: new Date().toISOString() };
}

function validateTimeline(timeline: TimelineProject) {
    const trackIds = new Set<string>();
    for (const track of timeline.tracks) {
        if (!track.id || trackIds.has(track.id)) throw new Error("时间线轨道 ID 缺失或重复");
        trackIds.add(track.id);
        if (!("video audio subtitle text image".split(" ").includes(track.kind))) throw new Error(`未知轨道类型：${track.kind}`);
    }
    const clipIds = new Set<string>();
    for (const clip of timeline.clips) {
        if (!clip.id || clipIds.has(clip.id)) throw new Error("时间线片段 ID 缺失或重复");
        clipIds.add(clip.id);
        if (!trackIds.has(clip.trackId)) throw new Error(`片段 ${clip.id} 指向不存在的轨道`);
        finiteMs(clip.startMs, `片段 ${clip.id} 起点`);
        finiteMs(clip.durationMs, `片段 ${clip.id} 时长`, MIN_CLIP_DURATION_MS);
        if (!clip.nodeId) throw new Error(`片段 ${clip.id} 缺少 nodeId`);
        if (clip.overlay) {
            if (clip.kind !== "text" && clip.kind !== "image") throw new Error(`片段 ${clip.id} 的 overlay 类型无效`);
            assertOverlayRect(clip.overlay);
        }
        if (clip.sourceStartMs !== undefined) finiteMs(clip.sourceStartMs, `片段 ${clip.id} 源起点`);
        if (clip.kind !== "subtitle" && clip.sourceDurationMs !== undefined) {
            finiteMs(clip.sourceDurationMs, `片段 ${clip.id} 源时长`);
            if ((clip.sourceStartMs || 0) + clip.durationMs > clip.sourceDurationMs + 1) throw new Error(`片段 ${clip.id} 超出源素材时长`);
        }
        if (!clip.directMedia && !clip.nodeId.trim()) throw new Error(`片段 ${clip.id} 缺少有效素材引用`);
        const track = timeline.tracks.find((item) => item.id === clip.trackId)!;
        if (track.kind !== clip.kind) throw new Error(`片段 ${clip.id} 类型与轨道类型不匹配`);
    }
    // Track exclusivity is part of the editor's placement contract for all media and subtitle clips.
    for (const clip of timeline.clips) {
        if (!canPlaceAt({ trackId: clip.trackId, startMs: clip.startMs, durationMs: clip.durationMs, excludeClipId: clip.id, clips: timeline.clips }).ok) {
            throw new Error(`片段 ${clip.id} 与同轨其他片段重叠`);
        }
    }
}

async function readDurableProject(projectId: string): Promise<CanvasProject> {
    const scope = getActiveUserScope();
    const raw = await localForageStorageForScope(scope).getItem(CANVAS_STORE_KEY);
    const document = parseCanvasStorageDocument(raw, useCanvasStore.getState().projects);
    const project = document.state.projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`本机持久化中找不到画布 ${projectId}`);
    return project;
}

function requireMatchingMemoryProject(projectId: string, expectedHash: string, durableProject: CanvasProject) {
    const memoryProject = useCanvasStore.getState().openProject(projectId);
    if (!memoryProject) throw new Error(`当前画布 ${projectId} 已关闭或不存在`);
    if (canvasAgentTimelineProjectHash(durableProject) !== expectedHash || canvasAgentTimelineProjectHash(memoryProject) !== expectedHash) {
        throw new Error("画布持久化版本已变化，请重新读取时间线后再执行写操作");
    }
    return memoryProject;
}

/** Flushes pending local writes and returns a hash that must accompany every subsequent write. */
export async function readCanvasAgentTimeline(projectId: string): Promise<CanvasAgentTimelineSnapshot> {
    requireProjectId(projectId);
    await flushCanvasStorePersistence();
    const project = await readDurableProject(projectId);
    const memoryProject = useCanvasStore.getState().openProject(projectId);
    if (!memoryProject || canvasAgentTimelineProjectHash(memoryProject) !== canvasAgentTimelineProjectHash(project)) {
        throw new Error("画布内存状态与本机持久化状态不一致，无法安全读取时间线");
    }
    return {
        projectId,
        expectedHash: canvasAgentTimelineProjectHash(project),
        timeline: initialTimeline(project),
        projectUpdatedAt: project.updatedAt,
    };
}

function trackFor(timeline: TimelineProject, trackId: string, kind: TimelineClip["kind"]): TimelineTrack {
    const track = timeline.tracks.find((item) => item.id === trackId);
    if (!track) throw new Error(`轨道 ${trackId} 不存在`);
    if (track.locked) throw new Error(`轨道 ${track.label} 已锁定`);
    if (track.kind !== kind) throw new Error(`轨道 ${track.label} 不接受 ${kind} 片段`);
    return track;
}

function buildSubtitleNodePatches(project: CanvasProject, previousTimeline: TimelineProject, timeline: TimelineProject): CanvasAgentTimelineNodePatch[] {
    const affectedNodeIds = new Set([
        ...previousTimeline.clips.filter((clip) => clip.kind === "subtitle").map((clip) => clip.nodeId),
        ...timeline.clips.filter((clip) => clip.kind === "subtitle").map((clip) => clip.nodeId),
    ]);
    const patches: CanvasAgentTimelineNodePatch[] = [];
    for (const node of project.nodes) {
        if (!affectedNodeIds.has(node.id)) continue;
        const baseMs = timeline.clips.find((clip) => clip.kind === "video" && clip.nodeId === node.id)?.startMs ?? 0;
        const entries: SrtEntry[] = timeline.clips
            .filter((clip) => clip.kind === "subtitle" && clip.nodeId === node.id && Boolean(clip.text?.trim()))
            .sort((left, right) => left.startMs - right.startMs)
            .map((clip, index) => ({
                index: index + 1,
                startMs: Math.max(0, Math.round(clip.startMs - baseMs)),
                endMs: Math.max(0, Math.round(clip.startMs + clip.durationMs - baseMs)),
                text: clip.text!.trim(),
            }));
        const oldEntries = node.metadata?.subtitleEntries || [];
        const oldHighlights = node.metadata?.subtitleHighlights || [];
        const { remapped, dropped } = remapHighlightsAfterResegment(oldEntries.length ? oldHighlights : [], entries);
        if (dropped.length) throw new Error(`节点 ${node.id} 有 ${dropped.length} 条字幕重点无法安全映射；请先处理重点字幕后再修改时间线`);
        if (JSON.stringify(oldEntries) === JSON.stringify(entries) && JSON.stringify(oldHighlights) === JSON.stringify(remapped)) continue;
        patches.push({ nodeId: node.id, subtitleEntries: entries, subtitleHighlights: remapped });
    }
    return patches;
}

async function assertReadableMediaReference(clip: TimelineClip, project: CanvasProject) {
    let storageKey = clip.directMedia?.storageKey;
    let content = clip.directMedia?.dataUrl || clip.directMedia?.url || clip.directMedia?.content || "";
    let probedDurationMs = clip.directMedia?.durationMs;
    if (!clip.directMedia) {
        const node = project.nodes.find((item) => item.id === clip.nodeId);
        if (!node) throw new Error(`片段素材节点 ${clip.nodeId} 不存在`);
        if (clip.kind !== node.type) throw new Error("片段类型与画布素材节点类型不匹配");
        storageKey = node.metadata?.storageKey;
        content = node.metadata?.content || "";
        probedDurationMs = node.metadata?.durationMs;
    } else if (clip.directMedia.kind !== clip.kind) {
        throw new Error("直连媒体类型与片段类型不匹配");
    }

    if (clip.kind === "video" || clip.kind === "audio") {
        if (!(probedDurationMs && probedDurationMs > 0) || !(clip.sourceDurationMs && clip.sourceDurationMs > 0)) {
            throw new Error("插入视频/音频必须提供已探测的 sourceDurationMs 和媒体时长");
        }
        if (Math.abs(clip.sourceDurationMs - probedDurationMs) > 1) throw new Error("sourceDurationMs 与已探测媒体时长不一致");
    }
    if (clip.kind === "text") {
        timelineOverlayRect(clip);
        if (!(clip.text ?? content).trim()) throw new Error(`文本片段 ${clip.id} 缺少文本内容`);
        return;
    }
    if (clip.kind === "image") timelineOverlayRect(clip);
    if (storageKey) {
        try {
            const blob = await getMediaBlob(storageKey);
            if (blob instanceof Blob && blob.size > 0) return;
        } catch {
            // Fall through to the same resource URL resolution used by the timeline preview.
        }
    }
    if (!content && storageKey) content = await resolveMediaUrl(storageKey, "");
    if (!content.trim()) throw new Error(`片段 ${clip.id} 没有可读取的素材资源引用`);
    let response: Response;
    try {
        response = await fetch(content, { credentials: "include" });
    } catch {
        throw new Error(`片段 ${clip.id} 的素材引用不可读取`);
    }
    if (!response.ok) throw new Error(`片段 ${clip.id} 的素材读取失败（HTTP ${response.status}）`);
    if (!(await response.blob()).size) throw new Error(`片段 ${clip.id} 的素材为空`);
}

async function applyOperation(project: CanvasProject, sourceTimeline: TimelineProject, operation: CanvasAgentTimelineOperation): Promise<{ timeline: TimelineProject; changedClipIds: string[] }> {
    const timeline = structuredClone(sourceTimeline);
    const changed = new Set<string>();
    const getClip = (clipId: string) => {
        const clip = timeline.clips.find((item) => item.id === clipId);
        if (!clip) throw new Error(`找不到片段 ${clipId}`);
        return clip;
    };

    switch (operation.type) {
        case "clip.insert": {
            if (operation.clip.kind === "subtitle") throw new Error("字幕片段请使用 subtitle.create，以便同步字幕节点数据");
            if (operation.clip.overlay && operation.clip.kind !== "text" && operation.clip.kind !== "image") throw new Error("overlay 仅支持文字或图片片段");
            if (operation.clip.overlay) assertOverlayRect(operation.clip.overlay);
            if (timeline.clips.some((clip) => clip.id === operation.clip.id)) throw new Error(`片段 ID ${operation.clip.id} 已存在`);
            const track = trackFor(timeline, operation.clip.trackId, operation.clip.kind);
            await assertReadableMediaReference(operation.clip, project);
            if (track.locked) throw new Error(`轨道 ${track.label} 已锁定`);
            timeline.clips.push({ ...operation.clip, startMs: finiteMs(operation.clip.startMs, "片段起点"), durationMs: finiteMs(operation.clip.durationMs, "片段时长", MIN_CLIP_DURATION_MS) });
            changed.add(operation.clip.id);
            break;
        }
        case "clip.move": {
            const clip = getClip(operation.clipId);
            const trackId = operation.trackId || clip.trackId;
            trackFor(timeline, trackId, clip.kind);
            const startMs = finiteMs(operation.startMs, "片段起点");
            const collision = canPlaceAt({ trackId, startMs, durationMs: clip.durationMs, excludeClipId: clip.id, clips: timeline.clips });
            if (!collision.ok) throw new Error("目标位置与同轨片段重叠");
            Object.assign(clip, { startMs, trackId });
            changed.add(clip.id);
            break;
        }
        case "clip.trim": {
            const clip = getClip(operation.clipId);
            if (clip.kind === "subtitle") throw new Error("字幕请使用 subtitle.update 修改起点或时长");
            if (!Number.isFinite(operation.deltaMs)) throw new Error("裁剪量必须是有限毫秒数");
            const deltaMs = Math.round(operation.deltaMs);
            const startMs = operation.edge === "left" ? finiteMs(clip.startMs + deltaMs, "片段起点") : clip.startMs;
            const durationMs = finiteMs(operation.edge === "left" ? clip.durationMs - deltaMs : clip.durationMs + deltaMs, "片段时长", MIN_CLIP_DURATION_MS);
            const sourceStartMs = operation.edge === "left" ? finiteMs((clip.sourceStartMs || 0) + deltaMs, "源素材起点") : clip.sourceStartMs;
            if (clip.sourceDurationMs !== undefined && (sourceStartMs ?? 0) + durationMs > clip.sourceDurationMs + 1) throw new Error("裁剪结果超出源素材时长");
            if (!canPlaceAt({ trackId: clip.trackId, startMs, durationMs, excludeClipId: clip.id, clips: timeline.clips }).ok) throw new Error("裁剪结果与同轨片段重叠");
            Object.assign(clip, { startMs, durationMs, ...(sourceStartMs === undefined ? {} : { sourceStartMs }) });
            changed.add(clip.id);
            break;
        }
        case "clip.split": {
            const clip = getClip(operation.clipId);
            if (clip.kind !== "video" && clip.kind !== "audio") throw new Error("只支持切分视频和音频片段");
            const atMs = finiteMs(operation.atMs, "切分点");
            const offset = atMs - clip.startMs;
            if (offset < MIN_CLIP_DURATION_MS || clip.durationMs - offset < MIN_CLIP_DURATION_MS) throw new Error("切分点必须位于片段内部并距两端至少 100ms");
            const leftId = `${clip.id}-left-${nanoid(6)}`;
            const rightId = `${clip.id}-right-${nanoid(6)}`;
            const left = { ...clip, id: leftId, durationMs: offset };
            const rightSourceStart = (clip.sourceStartMs || 0) + offset;
            const right = {
                ...clip,
                id: rightId,
                startMs: atMs,
                durationMs: clip.durationMs - offset,
                sourceStartMs: rightSourceStart,
                ...(clip.sourceDurationMs === undefined ? {} : { sourceDurationMs: clip.sourceDurationMs }),
            };
            if (clip.sourceDurationMs !== undefined && rightSourceStart + right.durationMs > clip.sourceDurationMs + 1) throw new Error("切分结果超出源素材时长");
            timeline.clips = timeline.clips.filter((item) => item.id !== clip.id).concat(left, right);
            changed.add(clip.id);
            changed.add(leftId);
            changed.add(rightId);
            break;
        }
        case "clip.delete":
        case "subtitle.delete": {
            const clip = getClip(operation.clipId);
            if (operation.type === "subtitle.delete" && clip.kind !== "subtitle") throw new Error("指定片段不是字幕");
            timeline.clips = timeline.clips.filter((item) => item.id !== operation.clipId);
            changed.add(operation.clipId);
            break;
        }
        case "clip.setOverlay": {
            const clip = getClip(operation.clipId);
            if (clip.kind !== "text" && clip.kind !== "image") throw new Error("overlay 仅支持文字或图片片段");
            const track = timeline.tracks.find((item) => item.id === clip.trackId)!;
            if (track.locked) throw new Error(`轨道 ${track.label} 已锁定`);
            if (operation.overlay === null) delete clip.overlay;
            else { assertOverlayRect(operation.overlay); clip.overlay = { ...operation.overlay }; }
            changed.add(clip.id);
            break;
        }
        case "subtitle.create": {
            const text = operation.text.trim();
            if (!text) throw new Error("字幕文本不能为空");
            const trackId = operation.trackId || DEFAULT_SUBTITLE_TRACK_ID;
            trackFor(timeline, trackId, "subtitle");
            if (!project.nodes.some((node) => node.id === operation.nodeId)) throw new Error(`字幕关联节点 ${operation.nodeId} 不存在`);
            const clip: TimelineClip = {
                id: `subtitle-${nanoid(10)}`,
                kind: "subtitle",
                nodeId: operation.nodeId,
                trackId,
                startMs: finiteMs(operation.startMs, "字幕起点"),
                durationMs: finiteMs(operation.durationMs, "字幕时长", MIN_CLIP_DURATION_MS),
                text,
                title: text,
            };
            if (!canPlaceAt({ trackId, startMs: clip.startMs, durationMs: clip.durationMs, clips: timeline.clips }).ok) throw new Error("字幕位置与同轨字幕重叠");
            timeline.clips.push(clip);
            changed.add(clip.id);
            break;
        }
        case "subtitle.update": {
            const clip = getClip(operation.clipId);
            if (clip.kind !== "subtitle") throw new Error("指定片段不是字幕");
            if (operation.patch.text !== undefined) {
                const text = operation.patch.text.trim();
                if (!text) throw new Error("字幕文本不能为空；请使用 subtitle.delete 删除字幕");
                clip.text = text;
                clip.title = text;
            }
            const startMs = operation.patch.startMs === undefined ? clip.startMs : finiteMs(operation.patch.startMs, "字幕起点");
            const durationMs = operation.patch.durationMs === undefined ? clip.durationMs : finiteMs(operation.patch.durationMs, "字幕时长", MIN_CLIP_DURATION_MS);
            if (!canPlaceAt({ trackId: clip.trackId, startMs, durationMs, excludeClipId: clip.id, clips: timeline.clips }).ok) throw new Error("字幕更新后与同轨字幕重叠");
            Object.assign(clip, { startMs, durationMs });
            changed.add(clip.id);
            break;
        }
        case "track.create": {
            if (!("video audio subtitle text image".split(" ").includes(operation.kind))) throw new Error(`未知轨道类型：${operation.kind}`);
            const index = timeline.tracks.filter((item) => item.kind === operation.kind).length + 1;
            let id = `${operation.kind}-${index}`;
            while (timeline.tracks.some((item) => item.id === id)) id = `${operation.kind}-${Number(id.slice(operation.kind.length + 1)) + 1}`;
            const baseLabels: Record<TimelineTrack["kind"], string> = { video: "视频", image: "图片", text: "文本", audio: "音频", subtitle: "字幕" };
            const label = operation.label === undefined ? `${baseLabels[operation.kind]} ${index}` : operation.label.trim();
            if (!label) throw new Error("轨道名称不能为空");
            if (timeline.tracks.some((item) => item.label === label)) throw new Error(`轨道名称已存在：${label}`);
            timeline.tracks.push({ id, kind: operation.kind, label, order: timeline.tracks.reduce((max, item) => Math.max(max, item.order), -1) + 1 });
            break;
        }
        case "track.update": {
            const track = timeline.tracks.find((item) => item.id === operation.trackId);
            if (!track) throw new Error(`轨道 ${operation.trackId} 不存在`);
            const label = operation.patch.label?.trim();
            if (label !== undefined) {
                if (!label) throw new Error("轨道名称不能为空");
                if (timeline.tracks.some((item) => item.id !== track.id && item.label === label)) throw new Error(`轨道名称已存在：${label}`);
                track.label = label;
            }
            break;
        }
        case "track.delete": {
            const track = timeline.tracks.find((item) => item.id === operation.trackId);
            if (!track) throw new Error(`轨道 ${operation.trackId} 不存在`);
            if (timeline.tracks.filter((item) => item.kind === track.kind).length <= 1) throw new Error(`不能删除最后一条 ${track.kind} 轨道`);
            timeline.clips.filter((clip) => clip.trackId === track.id).forEach((clip) => changed.add(clip.id));
            timeline.tracks = timeline.tracks.filter((item) => item.id !== track.id);
            timeline.clips = timeline.clips.filter((clip) => clip.trackId !== track.id);
            for (const [index, item] of [...timeline.tracks].sort((a, b) => a.order - b.order).entries()) item.order = index;
            break;
        }
        case "track.reorder": {
            if (!Array.isArray(operation.trackIds) || operation.trackIds.length !== timeline.tracks.length || new Set(operation.trackIds).size !== operation.trackIds.length || operation.trackIds.some((id) => !timeline.tracks.some((item) => item.id === id))) {
                throw new Error("trackIds 必须恰好包含每条现有轨道一次");
            }
            const byId = new Map(timeline.tracks.map((item) => [item.id, item]));
            timeline.tracks = operation.trackIds.map((id, order) => ({ ...byId.get(id)!, order }));
            break;
        }
        case "track.setFlag": {
            const track = timeline.tracks.find((item) => item.id === operation.trackId);
            if (!track) throw new Error(`轨道 ${operation.trackId} 不存在`);
            if (!["visible", "locked", "muted"].includes(operation.flag) || typeof operation.value !== "boolean") throw new Error("轨道开关参数无效");
            track[operation.flag] = operation.value;
            break;
        }
        case "clip.audioMix": {
            const clip = getClip(operation.clipId);
            if (clip.kind !== "audio") throw new Error("音频混音属性仅支持独立音频片段");
            const track = timeline.tracks.find((item) => item.id === clip.trackId)!;
            if (track.locked) throw new Error(`轨道 ${track.label} 已锁定`);
            const keys = Object.keys(operation.patch);
            if (!keys.length || keys.some((key) => !["volume", "fadeInMs", "fadeOutMs"].includes(key))) throw new Error("音频混音 patch 只能包含 volume、fadeInMs、fadeOutMs，且不能为空");
            if (operation.patch.volume !== undefined && (!Number.isFinite(operation.patch.volume) || operation.patch.volume < 0 || operation.patch.volume > 2)) throw new Error("volume 必须在 0 到 2 之间");
            for (const [name, value] of [["fadeInMs", operation.patch.fadeInMs], ["fadeOutMs", operation.patch.fadeOutMs]] as const) {
                if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > clip.durationMs)) throw new Error(`${name} 必须是 0 到片段时长之间的安全整数毫秒数`);
            }
            Object.assign(clip, operation.patch);
            changed.add(clip.id);
            break;
        }
    }

    const normalized = normalizeTimeline(timeline);
    validateTimeline(normalized);
    return { timeline: normalized, changedClipIds: [...changed] };
}

/** Applies one guarded operation through the real local project update/persistence chain, then verifies durable readback. */
export async function applyCanvasAgentTimelineOperation(input: {
    projectId: string;
    expectedHash: string;
    operation: CanvasAgentTimelineOperation;
    commitTimelineChange?: CanvasAgentTimelineCommitPageState;
}): Promise<CanvasAgentTimelineOperationResult> {
    requireProjectId(input.projectId);
    if (!input.expectedHash?.trim()) throw new Error("时间线写操作必须提供 expectedHash");
    await flushCanvasStorePersistence();
    const durableBefore = await readDurableProject(input.projectId);
    const project = requireMatchingMemoryProject(input.projectId, input.expectedHash, durableBefore);
    const initial = initialTimeline(project);
    const clearedSubtitleNodeIds = new Set(project.nodes.filter((node) => (node.metadata?.subtitleEntries?.length || 0) === 0).map((node) => node.id));
    const baseTimeline = {
        ...initial,
        clips: initial.clips.filter((clip) => !(clip.kind === "subtitle" && clearedSubtitleNodeIds.has(clip.nodeId))),
    };
    const { timeline, changedClipIds } = await applyOperation(project, baseTimeline, input.operation);
    const subtitleNodePatches = buildSubtitleNodePatches(project, initial, timeline);

    // Asset reads above may be asynchronous. Recheck the full project version immediately before any write.
    await flushCanvasStorePersistence();
    const durableAtCommit = await readDurableProject(input.projectId);
    requireMatchingMemoryProject(input.projectId, input.expectedHash, durableAtCommit);

    if (subtitleNodePatches.length) {
        if (!input.commitTimelineChange) {
            throw new Error("此操作会改写字幕节点；必须通过页面 commitTimelineChange 回调提交，已拒绝直接写入");
        }
        await input.commitTimelineChange({
            projectId: input.projectId,
            expectedHash: input.expectedHash,
            timeline,
            subtitleNodePatches,
        });
    } else {
        // Timeline-only edits do not touch the React-owned node array.
        useCanvasStore.getState().updateProject(input.projectId, { timeline });
    }
    await flushCanvasStorePersistence();
    const durableAfter = await readDurableProject(input.projectId);
    const memoryAfter = useCanvasStore.getState().openProject(input.projectId);
    if (!memoryAfter || JSON.stringify(durableAfter.timeline) !== JSON.stringify(timeline) || JSON.stringify(memoryAfter.timeline) !== JSON.stringify(timeline)) {
        throw new Error("时间线保存后回读校验失败；请重新读取项目状态后再继续");
    }
    for (const expectedNode of subtitleNodePatches) {
        if (
            JSON.stringify(durableAfter.nodes.find((node) => node.id === expectedNode.nodeId)?.metadata?.subtitleEntries || []) !== JSON.stringify(expectedNode.subtitleEntries) ||
            JSON.stringify(memoryAfter.nodes.find((node) => node.id === expectedNode.nodeId)?.metadata?.subtitleEntries || []) !== JSON.stringify(expectedNode.subtitleEntries) ||
            JSON.stringify(durableAfter.nodes.find((node) => node.id === expectedNode.nodeId)?.metadata?.subtitleHighlights || []) !== JSON.stringify(expectedNode.subtitleHighlights) ||
            JSON.stringify(memoryAfter.nodes.find((node) => node.id === expectedNode.nodeId)?.metadata?.subtitleHighlights || []) !== JSON.stringify(expectedNode.subtitleHighlights)
        ) {
            throw new Error(`字幕保存后回读校验失败（节点 ${expectedNode.nodeId}）`);
        }
    }
    return {
        projectId: input.projectId,
        expectedHash: canvasAgentTimelineProjectHash(durableAfter),
        timeline: durableAfter.timeline || timeline,
        changedClipIds,
    };
}

/**
 * Timeline media materialization (File upload, browser probing, FFmpeg processing) stays in the caller.
 * `clip.insert` accepts only the fully resolved TimelineClip after those steps have completed.
 */
export const canvasAgentTimelineIntegration = {
    read: readCanvasAgentTimeline,
    apply: applyCanvasAgentTimelineOperation,
};
