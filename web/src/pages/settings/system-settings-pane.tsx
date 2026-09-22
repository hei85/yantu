import { App, ConfigProvider } from "antd";
import { lazy, Suspense, type ReactNode } from "react";

import { getIsolatedAdminAntTheme } from "@/pages/admin/theme/admin-ant-theme";
import { useAppearanceStore } from "@/stores/use-appearance-store";
import { useThemeStore } from "@/stores/use-theme-store";

const StoryboardPromptsPage = lazy(() => import("@/pages/admin/storyboard-prompts/storyboard-prompts-page"));
const FeatureAvailabilityPage = lazy(() => import("@/pages/admin/admin-route-pages").then((module) => ({ default: module.FeatureAvailabilityPage })));
const DrawingEngineSettingsPage = lazy(() => import("@/pages/admin/settings/drawing-engine-settings-page"));
const ThirdPartySettingsPage = lazy(() => import("@/pages/admin/settings/libtv-settings-page"));

/**
 * 管理后台已经并入账户设置：这些页面继续使用后台的样式令牌与 antd 主题，
 * 但挂载在「设置 → 系统」分区里，不再有独立的 /admin 站点。
 */
function SystemSettingsPane({ children }: { children: ReactNode }) {
    const dark = useThemeStore((state) => state.theme === "dark");
    const skin = useAppearanceStore((state) => state.appearance.activeSkin);
    return (
        <ConfigProvider theme={getIsolatedAdminAntTheme(dark, skin)} getPopupContainer={(node) => node?.closest("[data-admin-root]") || document.body}>
            {/* antd <App> 默认带后台布局底色；内嵌进设置时必须透明，否则会出现“灰方框”。 */}
            <App className="settings-admin-embed-frame" style={{ background: "transparent" }}>
                <div data-admin-root className="settings-admin-embed">
                    <Suspense fallback={<div className="p-6 text-sm text-foreground/60" role="status">正在加载设置页面…</div>}>{children}</Suspense>
                </div>
            </App>
        </ConfigProvider>
    );
}

export function PromptTemplatesPane() {
    return <SystemSettingsPane><StoryboardPromptsPage /></SystemSettingsPane>;
}

export function FeatureAvailabilityPane() {
    return <SystemSettingsPane><FeatureAvailabilityPage /></SystemSettingsPane>;
}

export function DrawingEnginePane() {
    return <SystemSettingsPane><DrawingEngineSettingsPage /></SystemSettingsPane>;
}

export function ThirdPartySettingsPane() {
    return <SystemSettingsPane><ThirdPartySettingsPage /></SystemSettingsPane>;
}
