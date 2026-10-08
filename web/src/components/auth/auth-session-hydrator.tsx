import type { ReactNode } from "react";
import { useEffect } from "react";

import { FullScreenLoader } from "@/components/ui/aceternity/full-screen-loader";
import { preloadWorkspaceRoute } from "@/lib/workspace-route-modules";
import { getAuthSession, type AuthSessionPayload } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";

export function AuthSessionHydrator({ children }: { children: ReactNode }) {
    const hydrated = useUserStore((state) => state.hydrated);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const payload = await getAuthSession();
                if (cancelled) return;
                if (!payload.user) {
                    applyAnonymousSession(payload);
                    return;
                }
                const { applyUserSession } = await import("@/lib/user-session");
                if (cancelled) return;
                await applyUserSession(payload);
                preloadWorkspaceRoute(window.location.pathname);
            } catch {
                if (!cancelled) applyAnonymousSession({ user: null, logicalModels: [] });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    return hydrated ? children : <FullScreenLoader />;
}

function applyAnonymousSession(payload: AuthSessionPayload) {
    const store = useUserStore.getState();
    store.clearSession();
    store.setRuntimeLimits(payload.runtimeLimits);
    store.setDrawingEngine(payload.drawingEngine);
    store.setFeatures(payload.features);
    store.setHydrated(true);
}
