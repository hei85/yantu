import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { FullScreenLoader } from "@/components/ui/aceternity/full-screen-loader";
import { preloadWorkspaceRoute } from "@/lib/workspace-route-modules";
import { getAuthSession, type AuthSessionPayload } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";

export function AuthSessionHydrator({ children }: { children: ReactNode }) {
    const hydrated = useUserStore((state) => state.hydrated);
    const [error, setError] = useState("");
    const [retry, setRetry] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setError("");
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
            } catch (error) {
                if (!cancelled) {
                    useUserStore.getState().setHydrated(false);
                    setError(error instanceof Error ? error.message : "暂时无法连接本机工作区");
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [retry]);

    if (error) return <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-foreground" role="alert">
        <h1 className="text-xl font-semibold">工作区连接尚未完成</h1>
        <p className="max-w-xl text-center">{error}</p>
        <p className="text-sm text-muted-foreground">原有画布和资产已保留，连接恢复后继续读取。</p>
        <button className="rounded-lg border px-5 py-2" onClick={() => setRetry((value) => value + 1)}>重新连接</button>
    </div>;
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
