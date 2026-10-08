import { Button } from "antd";
import { Plus } from "lucide-react";
import { useEffect } from "react";

import { refreshSystemChannels } from "@/lib/user-session";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { ChannelSettingsPane } from "./channel-settings-pane";
import { ModelDefaultGrid } from "./model-default-grid";
import { ModelQuickConnectPane } from "./model-quick-connect-pane";

type ModelSetupView = "quick" | "channels" | "models";

export function ModelSetupPane({ view, onViewChange }: { view: ModelSetupView; onViewChange: (view: ModelSetupView) => void }) {
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const effectiveConfig = useEffectiveConfig();
    const canManageConnections = useUserStore((state) => state.user?.role === "admin");
    useEffect(() => {
        void refreshSystemChannels().catch(() => undefined);
    }, []);
    const views: Array<{ key: ModelSetupView; label: string }> = [
        ...(canManageConnections ? [
            { key: "quick" as const, label: "添加模型" },
            { key: "channels" as const, label: `已接入（${effectiveConfig.channels.length}）` },
        ] : []),
        { key: "models", label: "创作默认" },
    ];

    return (
        <div className="settings-pane model-setup-pane">
            <header className="settings-pane-header">
                <div className="min-w-0">
                    <h2>模型设置</h2>
                    <p>{canManageConnections ? "先添加模型，再按用途确认创作默认。一个 API Key 对应一个接入；图片和视频使用不同分组 Key 时，请分别添加。" : "在这里查看系统提供的模型，并选择各用途的创作默认。"}</p>
                </div>
            </header>
            <nav className="model-setup-tabs" aria-label="模型设置步骤">
                {views.map((item) => (
                    <button key={item.key} type="button" aria-current={view === item.key ? "page" : undefined} className={`model-setup-tab ${view === item.key ? "is-active" : ""}`} onClick={() => onViewChange(item.key)}>
                        {item.label}
                    </button>
                ))}
            </nav>
            {view === "quick" && canManageConnections ? <ModelQuickConnectPane onOpenAdvanced={() => onViewChange("channels")} /> : null}
            {view === "channels" && canManageConnections ? <ChannelSettingsPane onOpenQuick={() => onViewChange("quick")} onOpenModels={() => onViewChange("models")} /> : null}
            {view === "models" ? (
                <>
                    <div className="model-setup-empty-hint">
                        <span>默认只会影响对应用途。保存接入后系统会自动选中该用途的模型，也可以在这里更改。</span>
                        {canManageConnections ? <Button type="link" icon={<Plus className="size-4" />} onClick={() => onViewChange("quick")}>添加模型</Button> : null}
                    </div>
                    <ModelDefaultGrid config={effectiveConfig} onChange={(key, model) => updateConfig(key as Parameters<typeof updateConfig>[0], model)} />
                </>
            ) : null}
        </div>
    );
}
