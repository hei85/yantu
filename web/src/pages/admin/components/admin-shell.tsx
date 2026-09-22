import { App, ConfigProvider, Dropdown } from "antd";
import type { MenuProps } from "antd";
import {
    Activity,
    ArrowLeft,
    BarChart3,
    BellRing,
    ChevronLeft,
    ChevronRight,
    ChevronDown,
    CloudUpload,
    Coins,
    CreditCard,
    Database,
    FileClock,
    HardDrive,
    Home,
    Infinity as InfinityIcon,
    KeyRound,
    Layers3,
    Megaphone,
    MessageSquareText,
    Moon,
    Palette,
    Paintbrush,
    PlugZap,
    RefreshCw,
    Sparkles,
    Settings2,
    ShieldAlert,
    ShieldCheck,
    Sun,
    TicketCheck,
    ToggleLeft,
    UsersRound,
} from "lucide-react";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";

import { AppChangelogButton } from "@/components/layout/app-changelog-modal";
import { BrandLogoFrame } from "@/components/brand/brand-logo";
import { publishWorkspaceSidebarCollapsed, readWorkspaceSidebarCollapsed, subscribeWorkspaceSidebarCollapsed } from "@/components/layout/workspace-sidebar-state";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { useAppearanceStore } from "@/stores/use-appearance-store";
import { getIsolatedAdminAntTheme } from "../theme/admin-ant-theme";
import { AdminTooltip } from "../ui/controls";
import "@/styles/admin-ui.css";
import "../theme/admin-tokens.css";
import "../theme/admin-chrome.css";

type AdminNavigationItem = {
    path: string;
    label: string;
    description: string;
    icon: ReactNode;
    requireFeature?: "frontendModelsEnabled";
};

const adminNavigation: Array<{ label: string; items: AdminNavigationItem[] }> = [
    {
        label: "概览",
        items: [{ path: "/admin", label: "数据概览", description: "活跃、调用与成本趋势", icon: <BarChart3 className="size-4" /> }],
    },
    {
        label: "平台资源",
        items: [
            { path: "/admin/models", label: "前台模型", description: "展示、线路与用户价格", icon: <Layers3 className="size-4" />, requireFeature: "frontendModelsEnabled" },
            { path: "/admin/prompt-templates", label: "提示词模板", description: "平台创作策略版本", icon: <MessageSquareText className="size-4" /> },
            { path: "/admin/resources", label: "存储资源", description: "资源列表、容量与预览", icon: <Database className="size-4" /> },
        ],
    },
    {
        label: "系统配置",
        items: [
            { path: "/admin/settings/features", label: "功能开放", description: "工作台、插件与模型能力", icon: <ToggleLeft className="size-4" /> },
            { path: "/admin/settings/drawing-engine", label: "绘图工具", description: "画布绘图节点默认引擎", icon: <Paintbrush className="size-4" /> },
            { path: "/admin/settings/system-performance", label: "系统性能", description: "主机、数据库与缓存状态", icon: <Activity className="size-4" /> },
            // 邮件服务属于多用户注册/找回密码链路，本地单用户工作站已下线对应后端路由，这里不再展示入口。
            { path: "/admin/settings/third-party", label: "第三方参数配置", description: "先配置凭据，再开放用户入口", icon: <KeyRound className="size-4" /> },
        ],
    },
];

function isAdminNavigationPath(pathname: string, navigationPath: string) {
    if (navigationPath === "/admin") {
        return pathname === navigationPath;
    }
    return pathname === navigationPath || pathname.startsWith(`${navigationPath}/`);
}

function adminPopupContainer(node?: HTMLElement) {
    return document.getElementById("admin-root") || node?.closest("[data-admin-root]") || document.body;
}

export function AdminShell() {
    const appearance = useAppearanceStore((state) => state.appearance);
    const [collapsed, setCollapsed] = useState(readWorkspaceSidebarCollapsed);
    const dark = useThemeStore((state) => state.theme === "dark");

    useEffect(() => {
        document.body.classList.add("admin-overlays");
        return () => document.body.classList.remove("admin-overlays");
    }, []);

    useEffect(() => {
        return subscribeWorkspaceSidebarCollapsed(setCollapsed);
    }, []);

    const toggleCollapsed = () => {
        const next = !collapsed;
        setCollapsed(next);
        publishWorkspaceSidebarCollapsed(next);
    };

    return (
        <ConfigProvider theme={getIsolatedAdminAntTheme(dark, appearance.activeSkin)} getPopupContainer={(node) => adminPopupContainer(node)}>
            <App>
                <main id="admin-root" data-admin-root className="admin-shell flex h-full min-h-0 overflow-hidden">
                    <aside className={cn("admin-sidebar hidden shrink-0 flex-col overflow-hidden lg:flex", collapsed && "is-collapsed")}>
                        <div className="admin-sidebar-identity shrink-0">
                            <AdminTooltip title={collapsed ? "查看更新日志" : undefined} placement="right">
                                <AppChangelogButton
                                    className={cn("admin-sidebar-brand-button", collapsed && "is-collapsed")}
                                    icon={<BrandLogoFrame className="admin-sidebar-brand-mark grid shrink-0 place-items-center bg-foreground text-background" logoClassName="size-5 object-contain" alt="" fallback={<InfinityIcon className="size-4" />} />}
                                    label={appearance.brandName}
                                    showLabel={!collapsed}
                                    showVersion={!collapsed}
                                    labelClassName="admin-sidebar-brand-title"
                                    versionClassName="admin-sidebar-brand-version"
                                />
                            </AdminTooltip>
                        </div>
                        <AdminNavigation collapsed={collapsed} />
                        <div className="admin-sidebar-footer shrink-0">
                            <AdminTooltip title={collapsed ? "返回创作台" : undefined} placement="right">
                                <NavLink to="/" aria-label={collapsed ? "返回创作台" : undefined} className={cn("admin-nav-link", collapsed && "is-collapsed")}>
                                    <Home className="size-4" strokeWidth={1.6} />
                                    {!collapsed ? <span>返回创作台</span> : null}
                                </NavLink>
                            </AdminTooltip>
                        </div>
                    </aside>
                    <AdminTooltip title={collapsed ? "展开侧栏" : "收起侧栏"} placement="right">
                        <button type="button" className={cn("admin-sidebar-edge-toggle hidden lg:grid", collapsed && "is-collapsed")} onClick={toggleCollapsed} aria-label={collapsed ? "展开侧栏" : "收起侧栏"} aria-expanded={!collapsed}>
                            {collapsed ? <ChevronRight className="size-3.5" aria-hidden="true" /> : <ChevronLeft className="size-3.5" aria-hidden="true" />}
                        </button>
                    </AdminTooltip>
                    <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
                        <MobileAdminNavigation />
                        <Suspense
                            fallback={
                                <div className="p-8 text-sm" role="status">
                                    正在加载管理页面…
                                </div>
                            }
                        >
                            <Outlet />
                        </Suspense>
                    </section>
                </main>
            </App>
        </ConfigProvider>
    );
}

export function AdminPageFrame({ title, description, actions, back, scroll = false, section, children }: { title: string; description?: string; actions?: ReactNode; back?: { label: string; onClick: () => void }; scroll?: boolean; section?: { label: string; path: string }; children: ReactNode }) {
    const location = useLocation();
    const currentSection = adminNavigation.find((section) => section.items.some((item) => isAdminNavigationPath(location.pathname, item.path)));
    const currentItem = currentSection?.items.find((item) => isAdminNavigationPath(location.pathname, item.path));
    // 同一个面板也会被非管理后台的页面复用（例如设置里的模型渠道），此时由调用方指定表头归属。
    // 独立的管理后台已并入设置页，这些面板不再属于 /admin 站点。
    const sectionLabel = section?.label ?? (back ? (currentItem?.label ?? currentSection?.label ?? "设置") : (currentSection?.label ?? "设置"));
    const sectionPath = section?.path ?? (back ? (currentItem?.path ?? currentSection?.items[0]?.path ?? "/settings") : (currentSection?.items[0]?.path ?? "/settings"));

    return (
        <div className={cn("admin-page-root", scroll && "admin-page-root-scrollable")}>
            <div className={cn("admin-page-frame", scroll && "admin-page-frame-scrollable")}>
                <header className="admin-page-header flex shrink-0 flex-col sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2.5">
                        {back ? (
                            <AdminTooltip title={back.label}>
                                <button type="button" className="admin-icon-button shrink-0" aria-label={back.label} onClick={back.onClick}>
                                    <ArrowLeft className="size-4" />
                                </button>
                            </AdminTooltip>
                        ) : null}
                        <div className="admin-page-title-block min-w-0">
                            <nav className="admin-page-location" aria-label="当前位置">
                                <Link to={sectionPath} className="admin-page-location-section">
                                    {sectionLabel}
                                </Link>
                                <span className="admin-page-location-separator" aria-hidden="true">
                                    /
                                </span>
                                <h1 className="admin-page-title truncate">{title}</h1>
                            </nav>
                            {description ? <p className="admin-page-description">{description}</p> : null}
                        </div>
                    </div>
                    <div className="admin-page-actions flex shrink-0 flex-wrap items-center">
                        {actions}
                        <AdminThemeButton />
                    </div>
                </header>
                {children}
            </div>
        </div>
    );
}

function AdminThemeButton() {
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const dark = theme === "dark";

    return (
        <AdminTooltip title={dark ? "切换到浅色主题" : "切换到深色主题"} placement="bottom">
            <button type="button" className="admin-page-theme-toggle shrink-0" onClick={() => setTheme(dark ? "light" : "dark")} aria-label={dark ? "切换到浅色主题" : "切换到深色主题"}>
                {dark ? <Sun className="size-4" aria-hidden="true" /> : <Moon className="size-4" aria-hidden="true" />}
            </button>
        </AdminTooltip>
    );
}

function MobileAdminNavigation() {
    const features = useUserStore((state) => state.features);
    const location = useLocation();
    const visibleGroups = adminNavigation.map((group) => ({ ...group, items: group.items.filter((item) => !item.requireFeature || features[item.requireFeature]) })).filter((group) => group.items.length > 0);
    const visibleItems = visibleGroups.flatMap((group) => group.items);
    const currentItem = visibleItems.find((item) => item.path === location.pathname) || visibleItems[0];
    const menuItems: MenuProps["items"] = visibleGroups.map((group) => ({
        type: "group",
        key: `group-${group.label}`,
        label: group.label,
        children: group.items.map((item) => ({
            key: item.path,
            label: (
                <Link to={item.path} className="admin-mobile-navigation-menu-link">
                    {item.icon}
                    <span>{item.label}</span>
                </Link>
            ),
        })),
    }));

    return (
        <nav className="admin-mobile-navigation flex shrink-0 items-center justify-between gap-2 lg:hidden" aria-label="管理后台导航">
            <Dropdown menu={{ items: menuItems, selectable: true, selectedKeys: currentItem ? [currentItem.path] : [], className: "admin-mobile-navigation-menu" }} trigger={["click"]} placement="bottomLeft">
                <button type="button" className="admin-mobile-navigation-trigger" aria-label={`打开管理后台导航，当前页面${currentItem?.label || "未知"}`}>
                    <span className="admin-mobile-navigation-current-icon">{currentItem?.icon}</span>
                    <span className="min-w-0 text-left">
                        <span className="admin-mobile-navigation-eyebrow">管理后台</span>
                        <span className="admin-mobile-navigation-current-label">{currentItem?.label || "选择页面"}</span>
                    </span>
                    <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
                </button>
            </Dropdown>
            <div className="flex shrink-0 items-center gap-1">
                <AdminTooltip title="返回创作台">
                    <Link to="/" className="admin-mobile-navigation-action" aria-label="返回创作台">
                        <Home className="size-4" aria-hidden="true" />
                    </Link>
                </AdminTooltip>
                <AppChangelogButton className="admin-mobile-navigation-action [&_svg]:size-4" />
            </div>
        </nav>
    );
}

function AdminNavigation({ collapsed }: { collapsed: boolean }) {
    const features = useUserStore((state) => state.features);

    return (
        <nav className="admin-sidebar-nav thin-scrollbar flex-1 overflow-y-auto" aria-label="管理后台菜单">
            {adminNavigation.map((group) => {
                const visibleItems = group.items.filter((item) => !item.requireFeature || features[item.requireFeature]);
                if (visibleItems.length === 0) return null;

                return (
                    <div key={group.label} className="admin-nav-group">
                        {!collapsed ? (
                            <div className="admin-nav-group-label">
                                <span>{group.label}</span>
                            </div>
                        ) : (
                            <div className="admin-nav-collapsed-separator" />
                        )}
                        <div className={cn("admin-nav-group-items", collapsed && "is-collapsed")}>
                            {visibleItems.map((item) => (
                                <AdminTooltip key={item.path} delay={100} title={collapsed ? item.label : undefined} placement="right">
                                    <NavLink to={item.path} end={item.path === "/admin"} aria-label={collapsed ? item.label : undefined} className={({ isActive }) => cn("admin-nav-link", collapsed && "is-collapsed", isActive && "is-active")}>
                                        {item.icon}
                                        {!collapsed ? <span className="truncate">{item.label}</span> : null}
                                    </NavLink>
                                </AdminTooltip>
                            ))}
                        </div>
                    </div>
                );
            })}
        </nav>
    );
}
