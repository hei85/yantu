import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router";

import { FullScreenLoader, WorkspaceRouteLoader } from "@/components/ui/aceternity/full-screen-loader";
import { loadAssetsPage, loadCanvasPage, loadCanvasProjectPage, loadCreatePage, loadProjectDetailPage, loadProjectsPage } from "@/lib/workspace-route-modules";
import { CanvasRefreshShell } from "@/pages/canvas/canvas-refresh-shell";
import RouteErrorPage from "@/pages/route-error";

// 管理后台已并入「设置」：旧的 /admin 入口全部回流到设置页。
const RedirectAdminToSettings = () => <Navigate to="/settings" replace />;
const AssetsPage = lazy(loadAssetsPage);
const CanvasPage = lazy(loadCanvasPage);
const CanvasProjectPage = lazy(loadCanvasProjectPage);
const CreatePage = lazy(loadCreatePage);
const NotFound = lazy(() => import("@/pages/not-found"));
const SkillsPage = lazy(() => import("@/pages/skills"));
const PluginsPage = lazy(() => import("@/pages/plugins"));
const EagleLibraryPage = lazy(() => import("@/pages/plugins/eagle"));
const TasksPage = lazy(() => import("@/pages/tasks"));
const ProjectsPage = lazy(loadProjectsPage);
const ProjectDetailPage = lazy(loadProjectDetailPage);
const SettingsPage = lazy(() => import("@/pages/settings"));


const UserLayout = lazy(() => import("@/layouts/user-layout"));
const RequireFeature = lazy(() => import("@/components/auth/require-feature").then((module) => ({ default: module.RequireFeature })));

function deferred(element: ReactNode) {
    return <Suspense fallback={<WorkspaceRouteLoader />}>{element}</Suspense>;
}

function fullScreenDeferred(element: ReactNode) {
    return <Suspense fallback={<FullScreenLoader label="正在打开创作空间" detail="准备当前页面" />}>{element}</Suspense>;
}

function AuthenticatedWorkspaceLayout() {
    const { pathname } = useLocation();
    const isCanvasProjectRoute = pathname.startsWith("/canvas/");
    const fallback = isCanvasProjectRoute ? <CanvasRefreshShell /> : <FullScreenLoader label="正在打开创作空间" detail="准备当前页面" />;
    return <Suspense fallback={fallback}><UserLayout><Outlet /></UserLayout></Suspense>;
}

/**
 * DEV 专用实验室路由。
 *
 * lazy(() => import(...)) 写在函数体内，而不是模块顶层常量：
 * 生产构建时 import.meta.env.DEV 被替换为 false，本函数随之不可达，
 * 摇树会连同其中的动态 import 一起删除，实验室代码不进入生产依赖图。
 * 若把 lazy 提到模块顶层，动态 import 会被静态分析成真实 chunk 并打进 dist。
 */
function devRoutes() {
    const FolderPreviewLab = lazy(() => import("@/pages/dev/folder-preview-lab"));
    const DirectorReproLab = lazy(() => import("@/pages/dev/director-repro-lab"));
    return [
        { path: "/dev/folders", element: fullScreenDeferred(<FolderPreviewLab />), errorElement: <RouteErrorPage /> },
        { path: "/dev/director-repro", element: fullScreenDeferred(<DirectorReproLab />), errorElement: <RouteErrorPage /> },
    ];
}

export const router = createBrowserRouter([
    {
        path: "/login",
        element: <Navigate to="/" replace />,
        errorElement: <RouteErrorPage />,
    },
    { path: "/register", element: <Navigate to="/" replace /> },
    ...(import.meta.env.DEV ? devRoutes() : []),
    {
        element: <AuthenticatedWorkspaceLayout />,
        errorElement: <RouteErrorPage />,
        children: [
            { path: "/", element: deferred(<CreatePage />) },
            { path: "/create", element: deferred(<CreatePage />) },
            {
                path: "/tasks",
                element: (
                    <RequireFeature feature="taskCenterEnabled">{deferred(<TasksPage />)}</RequireFeature>
                ),
            },
            { path: "/assets", element: deferred(<AssetsPage />) },
            { path: "/skills", element: deferred(<SkillsPage />) },
            { path: "/settings", element: deferred(<SettingsPage />) },
            { path: "/connect", element: <Navigate to="/settings?section=quick" replace /> },


            {
                path: "/projects",
                element: (
                    <RequireFeature feature="shortDramaEnabled">{deferred(<ProjectsPage />)}</RequireFeature>
                ),
            },
            {
                path: "/projects/:projectId",
                element: (
                    <RequireFeature feature="shortDramaEnabled">{deferred(<ProjectDetailPage />)}</RequireFeature>
                ),
            },
            {
                path: "/projects/:projectId/:view",
                element: (
                    <RequireFeature feature="shortDramaEnabled">{deferred(<ProjectDetailPage />)}</RequireFeature>
                ),
            },
            {
                path: "/projects/:projectId/chapters/:chapterId",
                element: (
                    <RequireFeature feature="shortDramaEnabled">{deferred(<ProjectDetailPage />)}</RequireFeature>
                ),
            },
            {
                path: "/projects/:projectId/workflow/:unitId/:stage",
                element: (
                    <RequireFeature feature="shortDramaEnabled">{deferred(<ProjectDetailPage />)}</RequireFeature>
                ),
            },
            { path: "/canvas", element: deferred(<CanvasPage />) },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
            // 旧管理后台地址全部回流到「设置」对应分区，保留用户书签可用。
            { path: "/admin", element: <RedirectAdminToSettings /> },
            { path: "/admin/prompt-templates", element: <Navigate to="/settings?section=prompt-templates" replace /> },
            { path: "/admin/storyboard-prompts", element: <Navigate to="/settings?section=prompt-templates" replace /> },
            { path: "/admin/resources", element: <Navigate to="/settings" replace /> },
            { path: "/admin/settings/drawing-engine", element: <Navigate to="/settings?section=drawing-engine" replace /> },
            { path: "/admin/settings/system-performance", element: <Navigate to="/settings" replace /> },
            { path: "/admin/settings/third-party", element: <Navigate to="/settings?section=third-party" replace /> },
            { path: "/admin/*", element: <RedirectAdminToSettings /> },
        ],
    },
    { path: "*", element: fullScreenDeferred(<NotFound />) },
]);
