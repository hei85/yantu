import type { ProjectAsset } from "@/services/api/projects";
import type { Asset } from "@/stores/use-asset-store";

export type CanvasAgentAvailableAsset = {
    assetId: string;
    title: string;
    kind: string;
    category?: string;
    status?: string;
    ready: boolean;
    source: "local" | "project" | "local+project";
};

export type CanvasAgentAvailableAssetQuery = {
    query?: string;
    kind?: string;
    limit?: number;
};

const insertableKinds = new Set(["text", "image", "video", "audio", "character"]);

function localAssetReady(asset: Asset) {
    if (asset.kind === "text") return typeof asset.data.content === "string";
    if (asset.kind === "image") return Boolean(asset.data.storageKey || asset.data.dataUrl);
    if (asset.kind === "video" || asset.kind === "audio") return Boolean(asset.data.storageKey || asset.data.url);
    return false;
}

function projectAssetKind(asset: ProjectAsset) {
    if (asset.category === "character" && asset.character) return "character";
    return insertableKinds.has(asset.mediaType) ? asset.mediaType : undefined;
}

function projectAssetReady(asset: ProjectAsset, localAsset?: Asset) {
    if (asset.category === "character" && asset.character) {
        return asset.character.representations.some((item) => Boolean(item.resourceId));
    }
    if (localAsset && localAssetReady(localAsset)) return true;
    if (asset.mediaType === "text") return Boolean(asset.previewText);
    return Boolean(asset.storageKey);
}

export function findCanvasAgentAvailableAssets(input: CanvasAgentAvailableAssetQuery, localAssets: Asset[], projectAssets: ProjectAsset[] = []) {
    const localById = new Map(localAssets.map((asset) => [asset.id, asset]));
    const entries = new Map<string, CanvasAgentAvailableAsset>();
    for (const asset of localAssets) {
        if (!insertableKinds.has(asset.kind) || asset.status === "archived") continue;
        entries.set(asset.id, {
            assetId: asset.id,
            title: asset.title || "未命名素材",
            kind: asset.kind,
            ...(asset.category ? { category: asset.category } : {}),
            ...(asset.status ? { status: asset.status } : {}),
            ready: localAssetReady(asset),
            source: "local",
        });
    }
    for (const asset of projectAssets) {
        if (asset.status === "archived") continue;
        const kind = projectAssetKind(asset);
        if (!kind) continue;
        const existing = entries.get(asset.id);
        entries.set(asset.id, {
            assetId: asset.id,
            title: asset.title || existing?.title || "未命名素材",
            kind,
            category: asset.category,
            status: asset.status,
            ready: projectAssetReady(asset, localById.get(asset.id)),
            source: existing ? "local+project" : "project",
        });
    }
    const normalizedQuery = input.query?.trim().toLocaleLowerCase();
    const normalizedKind = input.kind?.trim().toLocaleLowerCase();
    const matches = [...entries.values()].filter((asset) => {
        if (normalizedKind && normalizedKind !== "all" && asset.kind.toLocaleLowerCase() !== normalizedKind) return false;
        if (!normalizedQuery) return true;
        return [asset.assetId, asset.title, asset.kind, asset.category || "", asset.status || ""]
            .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    });
    const requestedLimit = Number.isFinite(input.limit) ? Math.trunc(input.limit!) : 50;
    const limit = Math.min(100, Math.max(1, requestedLimit));
    return { assets: matches.slice(0, limit), total: matches.length, limit };
}
