import { create } from "zustand";
import { createJSONStorage, persist, type StorageValue } from "zustand/middleware";
import { nanoid } from "nanoid";

import { localForageStorageForScope } from "@/lib/localforage-storage";

export type AssetFolder = { id: string; name: string; createdAt: string; updatedAt: string };
export const ASSET_FOLDER_STORE_KEY = "infinite-canvas:asset-folders";

type AssetFolderStore = {
    hydrated: boolean;
    folders: AssetFolder[];
    createFolder: (name: string) => AssetFolder;
    updateFolder: (id: string, name: string) => void;
    deleteFolder: (id: string) => void;
};

export const useAssetFolderStore = create<AssetFolderStore>()(
    persist(
        (set) => ({
            hydrated: false,
            folders: [],
            createFolder: (name) => {
                const now = new Date().toISOString();
                const folder = { id: nanoid(), name: name.trim(), createdAt: now, updatedAt: now };
                set((state) => ({ folders: [folder, ...state.folders] }));
                return folder;
            },
            updateFolder: (id, name) => set((state) => ({ folders: state.folders.map((folder) => folder.id === id ? { ...folder, name: name.trim(), updatedAt: new Date().toISOString() } : folder) })),
            deleteFolder: (id) => set((state) => ({ folders: state.folders.filter((folder) => folder.id !== id) })),
        }),
        {
            name: ASSET_FOLDER_STORE_KEY,
            storage: createJSONStorage(() => localForageStorageForScope()),
            partialize: (state) => ({ folders: state.folders }) as StorageValue<AssetFolderStore>["state"],
            onRehydrateStorage: () => () => useAssetFolderStore.setState({ hydrated: true }),
        },
    ),
);

export async function flushAssetFolderStorePersistence() {
    const current = useAssetFolderStore.getState();
    const value: StorageValue<AssetFolderStore> = { state: { folders: current.folders } as AssetFolderStore, version: 0 };
    await localForageStorageForScope().setItem(ASSET_FOLDER_STORE_KEY, JSON.stringify(value));
}
