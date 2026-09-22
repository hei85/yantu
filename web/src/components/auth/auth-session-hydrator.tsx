import type { ReactNode } from "react";
import { useEffect } from "react";

import { FullScreenLoader } from "@/components/ui/aceternity/full-screen-loader";
import { localAutoLoginCredentials, localAutoLoginEnabled } from "@/lib/local-auto-login";
import { preloadWorkspaceRoute } from "@/lib/workspace-route-modules";
import { getAuthSession, login, type AuthSessionPayload } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";

export function AuthSessionHydrator({ children }: { children: ReactNode }) {
    const hydrated = useUserStore((state) => state.hydrated);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                let payload = await getAuthSession();
                if (cancelled) return;
                // 本地工作站：没有会话时用注入的固定账号静默登录，登录页不再出现。
                if (!payload.user && localAutoLoginEnabled()) {
                    await login(localAutoLoginCredentials());
                    if (cancelled) return;
                    payload = await getAuthSession();
                }
                if (cancelled) return;
                if (!payload.user) {
                    applyAnonymousSession(payload);
                    return;
                }
                // 账号数据、画布和素材持久化只属于已登录工作区，登录页不下载这些模块。
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
