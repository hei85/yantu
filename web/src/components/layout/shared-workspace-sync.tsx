import { useEffect, useState } from "react";
import { getActiveUserScope } from "@/lib/user-scope";
import { observedWorkspaceRevision, retrySharedWorkspaceWrites, SHARED_WORKSPACE_KEYS, sharedWorkspaceFailure, workspaceRevisions } from "@/lib/shared-workspace";
import { useUserStore } from "@/stores/use-user-store";

/** Cross-browser updates are announced in an open editor, never forced over an
 * in-progress interaction. Library pages refresh after local writes are flushed. */
export function SharedWorkspaceSync() {
    const userId = useUserStore((state) => state.user?.id);
    const [error, setError] = useState(sharedWorkspaceFailure);
    const [updated, setUpdated] = useState(false);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!userId) return;
        let cancelled = false;
        let checking = false;
        let lastInteraction = Date.now();
        const status = () => setError(sharedWorkspaceFailure());
        const merged = () => setUpdated(true);
        const interaction = () => { lastInteraction = Date.now(); };
        const check = async () => {
            if (checking || cancelled || document.hidden || getActiveUserScope() !== userId) return;
            checking = true;
            try {
                await retrySharedWorkspaceWrites(userId);
                const documents = await workspaceRevisions(userId);
                if (!cancelled) setError(sharedWorkspaceFailure());
                const changed = documents.some((document) => SHARED_WORKSPACE_KEYS.some((key) => key === document.key) && document.revision !== observedWorkspaceRevision(userId, document.key));
                if (!changed || cancelled) return;
                const isLibrary = /^\/(canvas|assets)\/?$/.test(window.location.pathname);
                if (isLibrary && Date.now() - lastInteraction > 2500 && !document.querySelector('[role="dialog"]')) {
                    const { refreshSharedWorkspaceStores } = await import("@/lib/user-session");
                    await refreshSharedWorkspaceStores();
                    if (!cancelled) setUpdated(false);
                } else if (!cancelled) setUpdated(true);
            } catch (error) {
                // Keep the loaded workspace on connection failures.
                if (!cancelled) setError(error instanceof Error ? error.message : "本机工作区连接暂时中断");
            } finally { checking = false; }
        };
        window.addEventListener("shared-workspace-status", status);
        window.addEventListener("shared-workspace-merged", merged);
        window.addEventListener("focus", check);
        window.addEventListener("online", check);
        window.addEventListener("pointerdown", interaction);
        window.addEventListener("keydown", interaction);
        const timer = window.setInterval(check, 10_000);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
            window.removeEventListener("shared-workspace-status", status);
            window.removeEventListener("shared-workspace-merged", merged);
            window.removeEventListener("focus", check);
            window.removeEventListener("online", check);
            window.removeEventListener("pointerdown", interaction);
            window.removeEventListener("keydown", interaction);
        };
    }, [userId]);
    const synchronize = async () => {
        if (busy) return;
        setBusy(true);
        try {
            await retrySharedWorkspaceWrites(getActiveUserScope());
            const { refreshSharedWorkspaceStores } = await import("@/lib/user-session");
            await refreshSharedWorkspaceStores();
            setError(sharedWorkspaceFailure());
            setUpdated(false);
        } catch (error) { setError(error instanceof Error ? error.message : "工作区同步失败"); }
        finally { setBusy(false); }
    };
    if (!error && !updated) return null;
    return <div role={error ? "alert" : "status"} className="fixed bottom-20 left-1/2 z-[1000] flex max-w-[90vw] -translate-x-1/2 items-center gap-3 rounded-xl border bg-background px-4 py-3 text-sm text-foreground shadow-lg">
        <span>{error ? `工作区同步尚未完成：${error}。请保留当前页面。` : "另一窗口已更新画布或资产"}</span>
        <button className="shrink-0 rounded-md border px-3 py-1" disabled={busy} onClick={() => void synchronize()}>{busy ? "正在同步" : error ? "重试保存" : "同步最新内容"}</button>
    </div>;
}
