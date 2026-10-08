import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Dropdown, Input, Modal } from "antd";
import { Select } from "@/components/ui/base/select";
import { ArrowDownAZ, Clock3, Download, FileUp, History, ListFilter, MoreHorizontal, Plus, Search, SlidersHorizontal, Trash2 } from "lucide-react";

import { CollectionGrid, PageHeader, WorkspacePage } from "@/components/layout/workspace-page";
import { CollectionToolbar } from "@/components/layout/collection-toolbar";
import { WorkspaceLoadingState, WorkspaceState } from "@/components/layout/workspace-state";

import { CanvasFolderCard } from "@/components/canvas/canvas-folder-card";
import { CanvasHistoryDrawer } from "@/components/canvas/canvas-history-drawer";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { importCanvasProjectArchive } from "@/lib/canvas/canvas-project-archive";
import { createLocalCanvasProject, loadLocalCanvasProject } from "@/services/local-canvas-projects";
import { listProjects } from "@/services/api/projects";
import { loadCanvasProjectPage } from "@/lib/workspace-route-modules";
import { useAppearanceStore } from "@/stores/use-appearance-store";

const CanvasDeleteProjectsDialog = lazy(() => import("@/components/canvas/canvas-delete-projects-dialog").then((module) => ({ default: module.CanvasDeleteProjectsDialog })));

export default function CanvasPage() {
    const { message } = App.useApp();
    const brandName = useAppearanceStore((state) => state.appearance.brandName);
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef(false);
    const [keyword, setKeyword] = useState("");
    const [sort, setSort] = useState<"updated" | "name" | "nodes">("updated");
    const [projectFilter, setProjectFilter] = useState("all");
    const loadMoreRef = useRef<HTMLDivElement>(null);
    const [loadedProjectCount, setLoadedProjectCount] = useState(50);
    const [openingProjectId, setOpeningProjectId] = useState("");
    const openingProjectIdRef = useRef("");
    const hydrated = useCanvasStore((state) => state.hydrated);
    const localProjects = useCanvasStore((state) => state.projects);
    const projects = useMemo(() => localProjects.map((project) => ({ ...project, nodeCount: project.nodes.length, previewNodes: project.nodes.slice(0, 4) })), [localProjects]);
    const totalProjects = projects.length;
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const deleteDialogOpen = useCanvasUiStore((state) => state.deleteProjectIds.length > 0);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [associationOpen, setAssociationOpen] = useState(false);
    const [associationProjectId, setAssociationProjectId] = useState("");
    const projectQuery = useQuery({ queryKey: ["projects"], queryFn: () => listProjects() });

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const handoffMode = mode === "handoff";
    const forwardedQuery = agentMode || handoffMode || searchParams.get("agent") === "1" ? `?${searchParams.toString()}` : "";
    const preloadProject = useCallback(() => {
        void loadCanvasProjectPage();
    }, []);
    const enterProject = useCallback(
        (id: string) => {
            if (openingProjectIdRef.current) return;
            openingProjectIdRef.current = id;
            setOpeningProjectId(id);
            preloadProject();
            window.requestAnimationFrame(() => navigate(`/canvas/${id}${forwardedQuery}`));
        },
        [forwardedQuery, navigate, preloadProject],
    );
    const createAndEnter = () => {
        enterProject(createLocalCanvasProject(`自由画布 ${projects.length + 1}`).id);
    };
    const filteredProjects = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        const scoped = projects.filter((project) => projectFilter === "all" || (projectFilter === "independent" ? !project.projectId : project.projectId === projectFilter));
        const values = query ? scoped.filter((project) => project.title.toLowerCase().includes(query)) : [...scoped];
        values.sort((a, b) => (sort === "name" ? a.title.localeCompare(b.title, "zh-CN") : sort === "nodes" ? b.nodeCount - a.nodeCount : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
        return values;
    }, [keyword, projectFilter, projects, sort]);
    const projectNames = useMemo(() => new Map((projectQuery.data?.projects || []).map(({ project }) => [project.id, project.name])), [projectQuery.data]);
    const visibleProjects = filteredProjects.slice(0, loadedProjectCount);
    const hasMore = visibleProjects.length < filteredProjects.length;
    const selectedProjects = projects.filter((project) => selectedIds.includes(project.id));
    const projectFilterLabel = projectFilter === "all" ? "全部画布" : projectFilter === "independent" ? "自由画布" : projectNames.get(projectFilter) || "项目画布";
    const sortLabel = sort === "name" ? "按名称" : sort === "nodes" ? "按节点" : "最近更新";
    const projectFilterItems = useMemo(() => [{ key: "all", label: "全部画布" }, { key: "independent", label: "自由画布" }, ...(projectQuery.data?.projects || []).map(({ project }) => ({ key: project.id, label: project.name }))], [projectQuery.data]);
    const sortItems = [
        { key: "updated", label: "最近更新", icon: <Clock3 className="size-3.5" /> },
        { key: "name", label: "按名称", icon: <ArrowDownAZ className="size-3.5" /> },
        { key: "nodes", label: "按节点数量", icon: <ListFilter className="size-3.5" /> },
    ];
    useEffect(() => {
        setLoadedProjectCount(50);
    }, [keyword, projectFilter, sort]);
    useEffect(() => {
        const node = loadMoreRef.current;
        if (!node || !hasMore) return;
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (!entry?.isIntersecting) return;
                setLoadedProjectCount((count) => Math.min(count + 50, filteredProjects.length));
            },
            { rootMargin: "600px" },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [filteredProjects.length, visibleProjects.length, hasMore]);
    const associateSelected = async (nextProjectId = associationProjectId) => {
        const projectId = nextProjectId || undefined;
        try {
            selectedIds.forEach((id) => updateProject(id, { projectId }));
            await flushCanvasStorePersistence();
            message.success(projectId ? "已加入项目" : "已移出项目，画布仍保留");
            setAssociationOpen(false);
        } catch (error) {
            message.error(error instanceof Error ? `画布关系保存失败：${error.message}` : "画布关系保存失败");
        }
    };
    const exportSelected = async () => {
        try {
            const selected = [];
            for (const id of selectedIds) {
                const project = loadLocalCanvasProject(id);
                if (!project) throw new Error("画布不存在，无法导出");
                selected.push(project);
            }
            await exportCanvasProjects(selected, `${brandName}画布-${selected.length}个画布`);
        } catch (error) { message.error(error instanceof Error ? error.message : "导出失败"); }
    };
    const importCanvas = async (file?: File) => {
        if (!file) return;
        const hideLoading = message.loading({ content: "正在解压并准备导入画布...", duration: 0 });
        try {
            const result = await importCanvasProjectArchive(file);
            if (result.detachedAssociations.length) message.warning(`已导入 ${result.projectCount} 个画布；${result.detachedAssociations.length} 个原短剧项目在本机不可用，画布已保留为独立画布`);
            else message.success(`已导入 ${result.projectCount} 个画布并保存到本地`);
        } catch (error) {
            console.error("导入画布失败", error);
            message.error(error instanceof Error ? `导入失败：${error.message}` : "导入失败，请选择有效的画布压缩包");
        } finally {
            hideLoading();
            if (inputRef.current) inputRef.current.value = "";
        }
    };
    useEffect(() => {
        if (!hydrated || autoOpenRef.current || (mode !== "new" && mode !== "recent" && mode !== "handoff")) return;
        autoOpenRef.current = true;
        if (mode === "recent" && projects[0]?.id) {
            enterProject(projects[0].id);
            return;
        }
        enterProject(createLocalCanvasProject(`自由画布 ${projects.length + 1}`).id);
    }, [hydrated, mode, projects, enterProject]);

    if (hydrated && (mode === "new" || mode === "recent" || mode === "handoff")) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">正在打开画布...</main>;

    return (
        <WorkspacePage className="studio-collection-page">
            <div className="studio-band">
                <PageHeader
                    title="我的画布"
                    description="把镜头、素材和想法留在同一张画布里。"
                    meta={<span className="app-projects-header-meta">{totalProjects} 个</span>}
                    actions={
                        <div className="collection-header-actions">
                            <Button type="primary" disabled={!hydrated} icon={<Plus />} onClick={createAndEnter}>
                                新建画布
                            </Button>
                            {projects.length ? (
                                <Dropdown
                                    menu={{
                                        classNames: { root: "canvas-library-actions-menu", item: "canvas-library-actions-menu-item" },
                                        items: [{ key: "delete-loaded", danger: true, icon: <Trash2 className="size-3.5" />, label: "删除当前已加载画布", onClick: () => setDeleteIds(projects.map((project) => project.id)) }],
                                    }}
                                    openClassName="is-open"
                                    placement="bottomRight"
                                    trigger={["click"]}
                                >
                                    <Button type="text" aria-label="更多画布操作" title="更多操作" icon={<MoreHorizontal />} />
                                </Dropdown>
                            ) : null}
                            <Button disabled={!hydrated} icon={<FileUp />} onClick={() => inputRef.current?.click()}>
                                导入
                            </Button>
                        </div>
                    }
                />

                <CollectionToolbar
                    label="画布浏览工具"
                    active={Boolean(keyword || projectFilter !== "all" || sort !== "updated")}
                    onReset={() => { setKeyword(""); setProjectFilter("all"); setSort("updated"); }}
                    trailing={<Button type="text" icon={<History />} onClick={() => setHistoryOpen(true)}>创作历史</Button>}
                >
                    <Input prefix={<Search />} value={keyword} allowClear placeholder="搜索画布" aria-label="搜索画布" onChange={(event) => setKeyword(event.target.value)} />
                    <Dropdown trigger={["click"]} placement="bottomLeft" menu={{ items: projectFilterItems, selectedKeys: [projectFilter], onClick: ({ key }) => setProjectFilter(String(key)) }}>
                        <Button icon={<SlidersHorizontal />} aria-label="按所属项目筛选">{projectFilterLabel}</Button>
                    </Dropdown>
                    <Dropdown trigger={["click"]} placement="bottomLeft" menu={{ items: sortItems, selectedKeys: [sort], onClick: ({ key }) => setSort(key as typeof sort) }}>
                        <Button icon={sort === "updated" ? <Clock3 /> : sort === "name" ? <ArrowDownAZ /> : <ListFilter />} aria-label="画布排序">{sortLabel}</Button>
                    </Dropdown>
                </CollectionToolbar>
            </div>

            <div className="collection-content">
                {selectedIds.length ? (
                    <div className="collection-selection-bar">
                        <strong className="mr-auto font-medium">已选 {selectedIds.length} 个画布</strong>
                        <Button
                            size="small"
                            disabled={!hydrated || projectQuery.isLoading}
                            onClick={() => {
                                setAssociationProjectId(selectedProjects[0]?.projectId || "");
                                setAssociationOpen(true);
                            }}
                        >
                            加入项目
                        </Button>
                        {selectedProjects.some((project) => project.projectId) ? (
                            <Button
                                size="small"
                                disabled={!hydrated}
                                onClick={() => {
                                    setAssociationProjectId("");
                                    void associateSelected("");
                                }}
                            >
                                移出项目
                            </Button>
                        ) : null}
                        <Button size="small" disabled={!hydrated} icon={<Download className="size-3.5" />} onClick={() => void exportSelected()}>
                            导出
                        </Button>
                        <Button size="small" danger disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>
                            删除
                        </Button>
                    </div>
                ) : null}

                {!hydrated ? (
                    <WorkspaceLoadingState label="正在恢复画布" detail="读取本机画布" />
                ) : visibleProjects.length ? (
                    <CollectionGrid className="canvas-collection-grid">
                        {visibleProjects.map((project) => (
                            <CanvasFolderCard
                                key={project.id}
                                project={project}
                                projectName={project.projectId ? projectNames.get(project.projectId) || "未同步项目" : undefined}
                                onClick={() => enterProject(project.id)}
                                onPrefetch={preloadProject}
                                opening={openingProjectId === project.id}
                            />
                        ))}
                    </CollectionGrid>
                ) : (
                    <WorkspaceState icon="canvas" title={keyword || projectFilter !== "all" ? "没有匹配的画布" : "让第一个想法落在画布上"} description={keyword || projectFilter !== "all" ? "换一个画布名称或重置筛选条件。" : "图片、分镜和灵感，都可以在这里自由组织。"} action={!keyword && projectFilter === "all" ? <Button type="primary" icon={<Plus />} disabled={!hydrated} onClick={createAndEnter}>新建画布</Button> : undefined} />
                )}
                {hydrated && visibleProjects.length ? (
                    <div ref={loadMoreRef} className="library-load-more" aria-live="polite">
                        {hasMore ? "继续下滑加载更多" : `已加载全部 ${filteredProjects.length} 个画布`}
                    </div>
                ) : null}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <Modal
                title="加入项目"
                open={associationOpen}
                okText="保存关联"
                cancelText="取消"
                okButtonProps={{ disabled: !associationProjectId, loading: projectQuery.isFetching }}
                onCancel={() => setAssociationOpen(false)}
                onOk={() => void associateSelected()}
            >
                <p className="mb-3 text-sm text-foreground/60">选中的画布会保留原有节点和本地媒体，只增加项目关联。</p>
                <Select
                    className="w-full"
                    value={associationProjectId || undefined}
                    placeholder="选择项目"
                    options={(projectQuery.data?.projects || []).map((item) => ({ label: item.project.name, value: item.project.id }))}
                    onChange={setAssociationProjectId}
                />
            </Modal>
            <CanvasHistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} />
            {deleteDialogOpen ? <Suspense fallback={null}><CanvasDeleteProjectsDialog /></Suspense> : null}
        </WorkspacePage>
    );
}
