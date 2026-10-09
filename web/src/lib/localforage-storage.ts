import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

import { getActiveUserScope, scopedStorageKey } from "@/lib/user-scope";
import { readSharedWorkspace, sharedWorkspaceHydrating, usesSharedWorkspace, writeSharedWorkspace } from "@/lib/shared-workspace";

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});

export function localForageStorageForScope(scope?: string): StateStorage {
    const keyFor = (name: string) => scopedStorageKey(name, scope);
    return {
        getItem: async (name) => {
            if (typeof window === "undefined") return null;
            const activeScope = scope ?? getActiveUserScope();
            if (usesSharedWorkspace(activeScope, name)) return readSharedWorkspace(activeScope, name);
            return (await localforage.getItem<string>(keyFor(name))) || null;
        },
        setItem: async (name, value) => {
            if (typeof window === "undefined") return;
            const activeScope = scope ?? getActiveUserScope();
            if (usesSharedWorkspace(activeScope, name)) {
                // Zustand hydration updates flags before replacing old memory.
                // These derived writes must not publish a stale/empty snapshot.
                if (sharedWorkspaceHydrating(activeScope)) return;
                return writeSharedWorkspace(activeScope, name, value);
            }
            await localforage.setItem(keyFor(name), value);
        },
        removeItem: async (name) => {
            if (typeof window === "undefined") return;
            const activeScope = scope ?? getActiveUserScope();
            if (usesSharedWorkspace(activeScope, name)) {
                if (sharedWorkspaceHydrating(activeScope)) return;
                return writeSharedWorkspace(activeScope, name, null);
            }
            await localforage.removeItem(keyFor(name));
        },
    };
}

export const localForageStorage: StateStorage = localForageStorageForScope();
