import localforage from "localforage";
import { scopedStorageKey } from "@/lib/user-scope";
import { ApiError, http } from "@/services/api/request";
import { parseCanvasStorageDocument, rebaseCanvasProjects, serializeCanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";
import { parseAssetStorageDocument, rebaseAssetSnapshot, serializeAssetStorageDocument } from "@/lib/asset-storage-revision";

export const SHARED_WORKSPACE_KEYS = [
    "infinite-canvas:canvas_store", "infinite-canvas:asset_store", "infinite-canvas:asset-folders",
    "infinite-canvas:deleted_history_store", "infinite-canvas:plugin-store",
] as const;
export type SharedDocument = { userId: string; key: string; value: string | null; revision: number; updatedAt?: string };
type PendingWrite = { value: string | null; base: SharedDocument };
const cache = localforage.createInstance({ name: "infinite-canvas", storeName: "app_state" });
const enabledScopes = new Set<string>();
const hydratingScopes = new Map<string, number>();
const observations = new Map<string, SharedDocument>();
const tails = new Map<string, Promise<unknown>>();
const failures = new Map<string, string>();

export function isSharedWorkspaceKey(key: string) { return SHARED_WORKSPACE_KEYS.some((item) => item === key) || key.startsWith("drawing:"); }
export function usesSharedWorkspace(scope: string, key: string) { return scope !== "guest" && enabledScopes.has(scope) && isSharedWorkspaceKey(key); }
export function enableSharedWorkspace(scope: string) { if (scope && scope !== "guest") enabledScopes.add(scope); }
export function beginSharedWorkspaceHydration(scope: string) { enableSharedWorkspace(scope); hydratingScopes.set(scope, (hydratingScopes.get(scope) || 0) + 1); }
export function endSharedWorkspaceHydration(scope: string) { const remaining = (hydratingScopes.get(scope) || 0) - 1; if (remaining > 0) hydratingScopes.set(scope, remaining); else hydratingScopes.delete(scope); }
export function sharedWorkspaceHydrating(scope: string) { return hydratingScopes.has(scope); }
export function sharedWorkspaceFailure() { return [...failures.values()][0] || ""; }

function report(id: string, error?: unknown) {
    if (error) failures.set(id, error instanceof Error ? error.message : String(error));
    else failures.delete(id);
    window.dispatchEvent(new Event("shared-workspace-status"));
}
function ordered<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = tails.get(id) || Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    tails.set(id, next);
    void next.finally(() => { if (tails.get(id) === next) tails.delete(id); }).catch(() => undefined);
    return next;
}
function assertScope(document: SharedDocument, scope: string) {
    if (document.userId !== scope) throw new Error("工作区账号不一致，已停止保存以保护原数据");
}
async function remote(scope: string, key: string) {
    const document = await http.get<SharedDocument>("/workspace/documents", { params: { key }, timeout: 30_000 });
    assertScope(document, scope);
    return document;
}
async function commit(scope: string, key: string, value: string | null, baseRevision: number) {
    const document = await http.put<SharedDocument>("/workspace/documents", { key, value, baseRevision }, { timeout: 60_000 });
    assertScope(document, scope);
    return document;
}
function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
function sameDocumentContents(key: string, a: string | null, b: string | null) {
    if (a === b) return true;
    if (a === null || b === null || (key !== SHARED_WORKSPACE_KEYS[0] && key !== SHARED_WORKSPACE_KEYS[1])) return false;
    // Resolving a browser-only preview can tick the store's local persistence
    // counter without changing any durable content. Do not create a server
    // revision (and cross-window refresh loop) for that counter alone.
    const left = JSON.parse(a);
    const right = JSON.parse(b);
    delete left.storageRevision;
    delete right.storageRevision;
    return same(left, right);
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function entityId(value: unknown): string | undefined {
    if (!record(value)) return undefined;
    if (typeof value.id === "string") return value.id;
    return record(value.manifest) && typeof value.manifest.id === "string" ? value.manifest.id : undefined;
}

// Three-way merge: only apply changes made after this browser's observed base.
// A stale browser never replaces a newer document with its complete snapshot.
function mergeValue(base: unknown, local: unknown, current: unknown): unknown {
    if (same(local, base)) return current;
    if (same(current, base)) return local;
    if (Array.isArray(local) && Array.isArray(current) && local.every(entityId) && current.every(entityId)) {
        const baseItems = new Map((Array.isArray(base) ? base : []).map((item) => [entityId(item), item]));
        const localItems = new Map(local.map((item) => [entityId(item), item]));
        const result = current.filter((item) => !baseItems.has(entityId(item)) || localItems.has(entityId(item)));
        for (const item of local) {
            const id = entityId(item);
            const position = result.findIndex((entry) => entityId(entry) === id);
            if (position >= 0) result[position] = mergeValue(baseItems.get(id), item, result[position]);
            else if (!baseItems.has(id)) result.push(item);
        }
        return result;
    }
    if (record(local) && record(current)) {
        const before = record(base) ? base : {};
        const result: Record<string, unknown> = { ...current };
        for (const key of new Set([...Object.keys(before), ...Object.keys(local)])) {
            if (!(key in local)) { if (same(current[key], before[key])) delete result[key]; }
            else if (!(key in current)) { if (!(key in before)) result[key] = local[key]; }
            else result[key] = mergeValue(before[key], local[key], current[key]);
        }
        return result;
    }
    return current;
}

function mergeDocument(key: string, baseValue: string | null, localValue: string | null, currentValue: string | null): string | null {
    if (localValue === baseValue) return currentValue;
    if (currentValue === baseValue) return localValue;
    // A server tombstone is authoritative over a stale client.
    if (currentValue === null) return null;
    if (localValue === null) throw new Error("另一浏览器已更新此工作区，清空操作尚未执行，请先刷新核对");
    if (key === SHARED_WORKSPACE_KEYS[0]) {
        const base = parseCanvasStorageDocument(baseValue);
        const local = parseCanvasStorageDocument(localValue);
        return serializeCanvasStorageDocument(rebaseCanvasProjects({
            document: parseCanvasStorageDocument(currentValue), baseProjects: base.state.projects,
            localProjects: local.state.projects, baseRevision: base.storageRevision,
        }).document);
    }
    if (key === SHARED_WORKSPACE_KEYS[1]) {
        const base = parseAssetStorageDocument(baseValue);
        const local = parseAssetStorageDocument(localValue);
        return serializeAssetStorageDocument(rebaseAssetSnapshot({
            document: parseAssetStorageDocument(currentValue), baseAssets: base.state.assets,
            localAssets: local.state.assets, baseRevision: base.storageRevision,
        }));
    }
    if (key.startsWith("drawing:") && baseValue && !same(JSON.parse(localValue).document, JSON.parse(baseValue).document) && !same(JSON.parse(currentValue).document, JSON.parse(baseValue).document)) {
        throw new Error("此绘图已在另一浏览器修改，当前原稿已保留，请先核对版本");
    }
    return JSON.stringify(mergeValue(baseValue ? JSON.parse(baseValue) : {}, JSON.parse(localValue), JSON.parse(currentValue)));
}

async function normalize(key: string, value: string | null, scope: string) {
    if (value === null) return null;
    const { prepareSharedWorkspaceMedia } = await import("@/lib/shared-workspace-media");
    return prepareSharedWorkspaceMedia(key, value, scope);
}
async function cacheAcknowledged(scope: string, key: string, document: SharedDocument) {
    const id = scopedStorageKey(key, scope);
    if (document.value === null) await cache.removeItem(id);
    else await cache.setItem(id, document.value);
    await cache.setItem(`${id}:shared-v1`, true);
    observations.set(id, document);
    report(id);
}

async function writePending(scope: string, key: string, pending: PendingWrite) {
    const id = scopedStorageKey(key, scope);
    const local = await normalize(key, pending.value, scope);
    for (let attempt = 0; attempt < 6; attempt++) {
        const current = await remote(scope, key);
        const value = current.revision === pending.base.revision ? local : mergeDocument(key, pending.base.value, local, current.value);
        try {
            const saved = sameDocumentContents(key, value, current.value) ? current : await commit(scope, key, value, current.revision);
            await cacheAcknowledged(scope, key, saved);
            await cache.removeItem(`${id}:shared-pending`);
            if (!sameDocumentContents(key, saved.value, local)) window.dispatchEvent(new Event("shared-workspace-merged"));
            return saved;
        } catch (error) {
            if (error instanceof ApiError && error.reason === "workspace_revision_conflict") continue;
            throw error;
        }
    }
    throw new Error("其他浏览器正在持续更新，当前修改已保留，稍后重试保存");
}

async function readInside(scope: string, key: string) {
    const id = scopedStorageKey(key, scope);
    const pending = await cache.getItem<PendingWrite>(`${id}:shared-pending`);
    if (pending) return writePending(scope, key, pending);
    let current = await remote(scope, key);
    const local = await cache.getItem<string>(id);
    const migrated = await cache.getItem<boolean>(`${id}:shared-v1`);
    if (local && (!migrated || current.revision === 0)) {
        // Preserve the untouched original before media promotion and merging.
        if (!(await cache.getItem(`${id}:before-shared-v1`))) await cache.setItem(`${id}:before-shared-v1`, local);
        const prepared = await normalize(key, local, scope);
        for (let attempt = 0; attempt < 6; attempt++) {
            // With no previous baseline, import additions only. Existing server
            // fields and tombstones take precedence; an empty Edge cannot erase Codex.
            const value = current.revision === 0 ? prepared : current.value === null ? null : mergeDocument(key, null, prepared, current.value);
            try {
                current = sameDocumentContents(key, value, current.value) ? current : await commit(scope, key, value, current.revision);
                break;
            } catch (error) {
                if (error instanceof ApiError && error.reason === "workspace_revision_conflict" && attempt < 5) { current = await remote(scope, key); continue; }
                throw error;
            }
        }
    }
    await cacheAcknowledged(scope, key, current);
    return current;
}

export async function readSharedWorkspace(scope: string, key: string): Promise<string | null> {
    const id = scopedStorageKey(key, scope);
    return ordered(id, async () => {
        try { return (await readInside(scope, key)).value; }
        catch (error) { report(id, error); throw error; }
    });
}
export async function writeSharedWorkspace(scope: string, key: string, value: string | null): Promise<void> {
    const id = scopedStorageKey(key, scope);
    return ordered(id, async () => {
        try {
            const base = observations.get(id) || await remote(scope, key);
            const pending: PendingWrite = { value, base };
            // This survives tab/browser closure and is replayed with its original
            // base revision; failed network writes are never reported as saved.
            await cache.setItem(`${id}:shared-pending`, pending);
            await writePending(scope, key, pending);
        } catch (error) { report(id, error); throw error; }
    });
}

export async function retrySharedWorkspaceWrites(scope: string) {
    for (const key of await cache.keys()) {
        const suffix = `:user:${scope}:shared-pending`;
        if (!key.endsWith(suffix)) continue;
        const name = key.slice(0, -suffix.length);
        if (isSharedWorkspaceKey(name)) await readSharedWorkspace(scope, name);
    }
}
export async function workspaceRevisions(scope: string) {
    const response = await http.get<{ documents: SharedDocument[] | null }>("/workspace/documents", { timeout: 15_000 });
    const documents = response.documents || [];
    documents.forEach((document) => assertScope(document, scope));
    return documents;
}
export function observedWorkspaceRevision(scope: string, key: string) { return observations.get(scopedStorageKey(key, scope))?.revision; }
