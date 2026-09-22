import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router";

import { RequireAuth } from "@/components/auth/require-auth";
import { useUserStore } from "@/stores/use-user-store";
import { FullScreenLoader, WorkspaceRouteLoader } from "@/components/ui/aceternity/full-screen-loader";
import { loadAssetsPage, loadCanvasPage, loadCanvasProjectPage, loadCreatePage, loadProjectDetailPage, loadProjectsPage } from "@/lib/workspace-route-modules";
import { CanvasRefreshShell } from "@/pages/canvas/canvas-refresh-shell";
import { AuthScene } from "@/pages/auth/auth-scene";
import RouteErrorPage from "@/pages/route-error";

// 管理后台已并入「设置」：旧的 /admin 入口全部回流到设置页。
const RedirectAdminToSettings = () => <Navigate to="/settings?section=features" replace />;
const AssetsPage = lazy(loadAssetsPage);
const LoginPage = lazy(() => import("@/pages/auth/login"));
const RegisterPage = lazy(() => import("@/pages/auth/register"));
const ForgotPasswordPage = lazy(() => import("@/pages/auth/forgot-password"));
const CanvasPage = lazy(loadCanvasPage);
const CanvasProjectPage = lazy(loadCanvasProjectPage);
const SharedCanvasPage = lazy(() => import("@/pages/canvas/shared"));
const CreatePage = lazy(loadCreatePage);
const NotFound = lazy(() => import("@/pages/not-found"));
const SkillsPage = lazy(() => import("@/pages/skills"));
const PluginsPage = lazy(() => import("@/pages/plugins"));
const EagleLibraryPage = lazy(() => import("@/pages/plugins/eagle"));
const TasksPage = lazy(() => import("@/pages/tasks"));
const ProjectsPage = lazy(loadProjectsPage);
const ProjectDetailPage = lazy(loadProjectDetailPage);
const SettingsPage = lazy(() => import("@/pages/settings"));
const TestVoiceRecording = lazy(() => import("@/pages/test-voice-recording"));
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
    return <RequireAuth><Suspense fallback={fallback}><UserLayout><Outlet /></UserLayout></Suspense></RequireAuth>;
}

// 本地工作站开启免登录后，会话在路由渲染前就已建立；此时直接回首页，不再展示登录表单。
function LoginRoute() {
    const hydrated = useUserStore((state) => state.hydrated);
    const user = useUserStore((state) => state.user);
    if (hydrated && user) return <Navigate to="/" replace />;
    return fullScreenDeferred(<LoginPage />);
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
        element: <AuthScene />,
        errorElement: <RouteErrorPage />,
        children: [
            { path: "/login", element: <LoginRoute /> },
            { path: "/register", element: fullScreenDeferred(<RegisterPage />) },
            { path: "/forgot-password", element: fullScreenDeferred(<ForgotPasswordPage />) },
        ],
    },
    { path: "/share/canvas/:token", element: fullScreenDeferred(<SharedCanvasPage />), errorElement: <RouteErrorPage /> },
    ...(import.meta.env.DEV ? devRoutes() : []),
    {
        element: <AuthenticatedWorkspaceLayout />,
        errorElement: <RouteErrorPage />,
        children: [
            { path: "/", element: <RequireAuth>{deferred(<CreatePage />)}</RequireAuth> },
            { path: "/create", element: <RequireAuth>{deferred(<CreatePage />)}</RequireAuth> },
            {
                path: "/tasks",
                element: (
                    <RequireAuth>
                        <RequireFeature feature="taskCenterEnabled">{deferred(<TasksPage />)}</RequireFeature>
                    </RequireAuth>
                ),
            },
            { path: "/assets", element: <RequireAuth>{deferred(<AssetsPage />)}</RequireAuth> },
            { path: "/skills", element: <RequireAuth>{deferred(<SkillsPage />)}</RequireAuth> },
            { path: "/settings", element: <RequireAuth>{deferred(<SettingsPage />)}</RequireAuth> },
            { path: "/connect", element: <Navigate to="/settings?section=quick" replace /> },
            { path: "/test-voice-recording", element: <RequireAuth>{deferred(<TestVoiceRecording />)}</RequireAuth> },
            {
                path: "/projects",
                element: (
                    <RequireAuth>
                        <RequireFeature feature="shortDramaEnabled">{deferred(<ProjectsPage />)}</RequireFeature>
                    </RequireAuth>
                ),
            },
            {
                path: "/projects/:projectId",
                element: (
                    <RequireAuth>
                        <RequireFeature feature="shortDramaEnabled">{deferred(<ProjectDetailPage />)}</RequireFeature>
                    </RequireAuth>
                ),
            },
            {
                path: "/projects/:projectId/:view",
                element: (
                    <RequireAuth>
                        <RequireFeature feature="shortDramaEnabled">{deferred(<ProjectDetailPage />)}</RequireFeature>
                    </RequireAuth>
                ),
            },
            {
                path: "/projects/:projectId/chapters/:chapterId",
                element: (
                    <RequireAuth>
                        <RequireFeature feature="shortDramaEnabled">{deferred(<ProjectDetailPage />)}</RequireFeature>
                    </RequireAuth>
                ),
            },
            {
                path: "/projects/:projectId/workflow/:unitId/:stage",
                element: (
                    <RequireAuth>
                        <RequireFeature feature="shortDramaEnabled">{deferred(<ProjectDetailPage />)}</RequireFeature>
                    </RequireAuth>
                ),
            },
            { path: "/canvas", element: <RequireAuth>{deferred(<CanvasPage />)}</RequireAuth> },
            { path: "/canvas/:id", element: <RequireAuth><CanvasProjectPage /></RequireAuth> },
            // 旧管理后台地址全部回流到「设置」对应分区，保留用户书签可用。
            { path: "/admin", element: <RequireAuth><RedirectAdminToSettings /></RequireAuth> },
            { path: "/admin/prompt-templates", element: <RequireAuth><Navigate to="/settings?section=prompt-templates" replace /></RequireAuth> },
            { path: "/admin/storyboard-prompts", element: <RequireAuth><Navigate to="/settings?section=prompt-templates" replace /></RequireAuth> },
            { path: "/admin/resources", element: <RequireAuth><Navigate to="/settings" replace /></RequireAuth> },
            { path: "/admin/settings/features", element: <RequireAuth><Navigate to="/settings?section=features" replace /></RequireAuth> },
            { path: "/admin/settings/drawing-engine", element: <RequireAuth><Navigate to="/settings?section=drawing-engine" replace /></RequireAuth> },
            { path: "/admin/settings/system-performance", element: <RequireAuth><Navigate to="/settings" replace /></RequireAuth> },
            { path: "/admin/settings/third-party", element: <RequireAuth><Navigate to="/settings?section=third-party" replace /></RequireAuth> },
            { path: "/admin/*", element: <RequireAuth><RedirectAdminToSettings /></RequireAuth> },
        ],
    },
    { path: "*", element: fullScreenDeferred(<NotFound />) },
]);
