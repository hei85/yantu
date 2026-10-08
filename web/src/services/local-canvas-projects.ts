import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";

export type CanvasLibrarySummary = Pick<CanvasProject, "id" | "projectId" | "title" | "createdAt" | "updatedAt" | "revision"> & {
    nodeCount: number;
    previewNodes: CanvasProject["nodes"];
};

export function createLocalCanvasProject(
    title: string,
    projectId?: string,
    initialContent?: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId">>,
) {
    const store = useCanvasStore.getState();
    const id = store.createProject(title, projectId);
    if (initialContent) store.updateProject(id, initialContent);
    return { id };
}

export function loadLocalCanvasProject(id: string) {
    return useCanvasStore.getState().openProject(id);
}

export async function deleteLocalCanvasProjects(ids: string[]) {
    useCanvasStore.getState().deleteProjects(ids);
    await flushCanvasStorePersistence();
}

export function validateLocalAssetsForUse(ids: Iterable<string>) {
    const available = new Set(useAssetStore.getState().assets.map((asset) => asset.id));
    const missing = [...new Set(ids)].filter((id) => !available.has(id));
    if (missing.length) throw new Error("部分素材不在本机素材库中，请重新选择素材");
}
