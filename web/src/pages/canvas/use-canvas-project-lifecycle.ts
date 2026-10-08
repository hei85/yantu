import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { App } from "antd";
import { useNavigate } from "react-router";

import { autoCanvasAppearance, canvasAppearanceBaseTheme, DEFAULT_CANVAS_BACKGROUND_MODE, normalizeCanvasAppearance, type CanvasAppearance } from "@/lib/canvas/canvas-appearance";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { removeCanvasDrawing } from "@/lib/canvas/canvas-drawing-storage";
import { normalizeCanvasNodeTimestamps } from "@/lib/canvas/canvas-node-timestamps";
import { hydrateAssistantImages, resetInterruptedGeneration } from "@/lib/canvas/canvas-project-generation";
import { listAddedSkills, type Skill } from "@/services/api/skills";
import { createLocalCanvasProject, deleteLocalCanvasProjects } from "@/services/local-canvas-projects";
import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasThemeStore } from "@/stores/canvas/use-canvas-theme-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import type { CanvasHistorySnapshot } from "./use-canvas-history";

type UseCanvasProjectLifecycleOptions = {
    projectId: string;
    projectLoaded: boolean;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    canvasAppearance: CanvasAppearance;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    chatSessionsRef: MutableRefObject<CanvasAssistantSession[]>;
    activeChatIdRef: MutableRefObject<string | null>;
    viewportRef: MutableRefObject<ViewportTransform>;
    historyPausedRef: MutableRefObject<boolean>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setChatSessions: Dispatch<SetStateAction<CanvasAssistantSession[]>>;
    setActiveChatId: Dispatch<SetStateAction<string | null>>;
    setCanvasAppearance: Dispatch<SetStateAction<CanvasAppearance>>;
    setBackgroundMode: Dispatch<SetStateAction<CanvasBackgroundMode>>;
    setShowImageInfo: Dispatch<SetStateAction<boolean>>;
    setViewport: Dispatch<SetStateAction<ViewportTransform>>;
    setProjectLoaded: Dispatch<SetStateAction<boolean>>;
    resetHistory: (snapshot: CanvasHistorySnapshot) => void;
    cleanupAssetImages: (options?: unknown) => void;
    cleanupCanvasFiles: (extra?: unknown) => void;
};

export function useCanvasProjectLifecycle({
    projectId,
    projectLoaded,
    nodes,
    connections,
    chatSessions,
    activeChatId,
    canvasAppearance,
    backgroundMode,
    showImageInfo,
    viewport,
    nodesRef,
    connectionsRef,
    chatSessionsRef,
    activeChatIdRef,
    viewportRef,
    historyPausedRef,
    setNodes,
    setConnections,
    setChatSessions,
    setActiveChatId,
    setCanvasAppearance,
    setBackgroundMode,
    setShowImageInfo,
    setViewport,
    setProjectLoaded,
    resetHistory,
    cleanupAssetImages,
    cleanupCanvasFiles,
}: UseCanvasProjectLifecycleOptions) {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const hydrated = useCanvasStore((state) => state.hydrated);
    const sessionHydrated = useUserStore((state) => state.hydrated);
    const openProject = useCanvasStore((state) => state.openProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const [addedSkills, setAddedSkills] = useState<Skill[]>([]);
    const [loadError, setLoadError] = useState("");
    const [loadAttempt, setLoadAttempt] = useState(0);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const observedContentRef = useRef<CanvasHistorySnapshot | null>(null);
    const editorReadyRef = useRef(false);
    const loadedProjectIdRef = useRef("");

    useEffect(() => {
        if (!hydrated || !sessionHydrated) return;
        let cancelled = false;
        const keepEditor = editorReadyRef.current && loadedProjectIdRef.current === projectId;
        if (!keepEditor) {
            editorReadyRef.current = false;
            setProjectLoaded(false);
            setLoadError("");
            observedContentRef.current = null;
        }
        const applyRestoredProject = (targetProject: CanvasProject) => {
            if (cancelled) return;
            // 画布默认跟随工作台主题：旧画布没有显式选择时不会停在浅色。
            const fallbackTheme = useThemeStore.getState().theme;
            const restoredAppearance = targetProject.appearance
                ? normalizeCanvasAppearance(targetProject.appearance, fallbackTheme)
                : autoCanvasAppearance();
            const initialNodes = normalizeCanvasNodeTimestamps(resetInterruptedGeneration(targetProject.nodes), {
                createdAt: targetProject.createdAt,
                updatedAt: targetProject.updatedAt,
            });
            // Restore can intentionally repair interrupted uploads/generations and
            // backfill node timestamps. Keep the store baseline in sync with the
            // editor baseline so a later flush cannot succeed while leaving the
            // restored nodes only in React state.
            if (JSON.stringify(initialNodes) !== JSON.stringify(targetProject.nodes)) {
                updateProject(projectId, { nodes: initialNodes });
            }
            const snapshot: CanvasHistorySnapshot = {
                nodes: initialNodes,
                connections: targetProject.connections,
                chatSessions: targetProject.chatSessions || [],
                activeChatId: targetProject.activeChatId || null,
                canvasAppearance: restoredAppearance,
                backgroundMode: targetProject.backgroundMode || DEFAULT_CANVAS_BACKGROUND_MODE,
                showImageInfo: targetProject.showImageInfo || false,
            };
            observedContentRef.current = snapshot;
            chatSessionsRef.current = snapshot.chatSessions;
            activeChatIdRef.current = snapshot.activeChatId;
            nodesRef.current = snapshot.nodes;
            connectionsRef.current = snapshot.connections;
            viewportRef.current = targetProject.viewport;
            setNodes(snapshot.nodes);
            setConnections(snapshot.connections);
            setChatSessions(snapshot.chatSessions);
            setActiveChatId(snapshot.activeChatId);
            setCanvasAppearance(snapshot.canvasAppearance);
            useCanvasThemeStore.getState().setTheme(canvasAppearanceBaseTheme(snapshot.canvasAppearance, fallbackTheme));
            setBackgroundMode(snapshot.backgroundMode);
            setShowImageInfo(snapshot.showImageInfo);
            setViewport(targetProject.viewport);
            resetHistory(snapshot);
            editorReadyRef.current = true;
            loadedProjectIdRef.current = projectId;
            setProjectLoaded(true);
        };

        const load = async () => {
            const loadedProject = openProject(projectId);
            if (cancelled) return;
            if (!loadedProject) {
                setLoadError("本机找不到这张画布");
                navigate("/canvas", { replace: true });
                return;
            }
            applyRestoredProject(loadedProject);

            // 画布媒体由节点自己的视口观察器按需加载；打开时遍历并解析全部节点会让大画布形成 N+1 资源读取。
            void hydrateAssistantImages(loadedProject.chatSessions || [])
                .then((hydratedSessions) => {
                    if (!cancelled) setChatSessions((current) => {
                        const merged = mergeHydratedSessions(current, hydratedSessions);
                        if (observedContentRef.current?.chatSessions === current) observedContentRef.current = { ...observedContentRef.current, chatSessions: merged };
                        return merged;
                    });
                })
                .catch(() => {
                    if (!cancelled) message.warning("部分助手会话素材恢复失败，已使用项目记录继续打开");
                });
        };
        void load()
            .then(() => {
                if (cancelled) return;
            })
            .catch((error) => {
                if (cancelled) return;
                const detail = error instanceof Error ? error.message : "读取画布失败，请重试";
                if (keepEditor) message.error(detail);
                else setLoadError(detail);
            });
        return () => {
            cancelled = true;
        };
    }, [hydrated, sessionHydrated, loadAttempt, message, navigate, openProject, projectId, resetHistory, setActiveChatId, setBackgroundMode, setCanvasAppearance, setChatSessions, setConnections, setNodes, setShowImageInfo, setViewport, updateProject]);

    useEffect(() => {
        if (!projectLoaded) return;
        let cancelled = false;
        listAddedSkills()
            .then(({ skills }) => {
                if (!cancelled) setAddedSkills(skills);
            })
            .catch(() => {
                if (!cancelled) setAddedSkills([]);
            });
        return () => {
            cancelled = true;
        };
    }, [projectLoaded]);

    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current) return;
        const snapshot = { nodes, connections, chatSessions, activeChatId, canvasAppearance, backgroundMode, showImageInfo };
        if (!observedContentRef.current || JSON.stringify(observedContentRef.current) === JSON.stringify(snapshot)) return;
        observedContentRef.current = snapshot;
        const patch = { nodes, connections, chatSessions, activeChatId, appearance: canvasAppearance, backgroundMode, showImageInfo };
        const stored = useCanvasStore.getState().projects.find((project) => project.id === projectId);
        // Avoid writing identical editor state back into the local project store.
        if (stored && Object.entries(patch).every(([key, value]) => JSON.stringify(stored[key as keyof CanvasProject]) === JSON.stringify(value))) return;
        updateProject(projectId, patch);
    }, [activeChatId, backgroundMode, canvasAppearance, chatSessions, connections, historyPausedRef, nodes, projectId, projectLoaded, showImageInfo, updateProject]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, updateProject, viewport, viewportRef]);

    useEffect(() => () => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        updateProject(projectId, { viewport: viewportRef.current });
    }, [projectId, projectLoaded, updateProject, viewportRef]);

    const createAndOpenProject = useCallback(() => {
        const { id } = createLocalCanvasProject(`自由画布 ${useCanvasStore.getState().projects.length + 1}`);
        navigate(`/canvas/${id}`);
    }, [navigate]);

    const deleteCurrentProject = useCallback(async () => {
        let drawingIds = nodesRef.current.flatMap((node) => node.type === "drawing" && node.metadata?.drawingId ? [node.metadata.drawingId] : []);
        try {
            await deleteLocalCanvasProjects([projectId]);
        } catch (error) {
            message.error(error instanceof Error ? `删除画布失败：${error.message}` : "删除画布失败，请稍后重试");
            return;
        }
        if (drawingIds.length) {
            void Promise.all(drawingIds.map((drawingId) => removeCanvasDrawing(projectId, drawingId)))
                .catch(() => message.warning("项目已删除，但部分本地绘图缓存清理失败"));
        }
        cleanupAssetImages();
        navigate("/canvas");
    }, [cleanupAssetImages, message, navigate, nodesRef, projectId]);

    const renameCurrentProject = useCallback((title: string) => {
        renameProject(projectId, title);
        void flushCanvasStorePersistence().catch((error) => message.error(error instanceof Error ? `本机保存失败：${error.message}` : "本机保存失败"));
    }, [message, projectId, renameProject]);

    const persistLocalEdits = useCallback(async () => {
        const snapshot = { nodes: nodesRef.current, connections: connectionsRef.current, chatSessions, activeChatId, canvasAppearance, backgroundMode, showImageInfo };
        if (observedContentRef.current && JSON.stringify(observedContentRef.current) !== JSON.stringify(snapshot)) {
            updateProject(projectId, {
                nodes: nodesRef.current,
                connections: connectionsRef.current,
                chatSessions,
                activeChatId,
                appearance: canvasAppearance,
                backgroundMode,
                showImageInfo,
                viewport: viewportRef.current,
            });
            observedContentRef.current = snapshot;
        }
        updateProject(projectId, { viewport: viewportRef.current });
        await flushCanvasStorePersistence();
    }, [activeChatId, backgroundMode, canvasAppearance, chatSessions, connectionsRef, nodesRef, projectId, showImageInfo, updateProject, viewportRef]);

    const persistLocalCanvas = useCallback(async (): Promise<boolean> => {
        try {
            await persistLocalEdits();
            return true;
        } catch {
            message.error("本机画布保存失败，请稍后重试");
            return false;
        }
    }, [message, persistLocalEdits]);

    const clearCanvasFiles = useCallback(() => {
        cleanupCanvasFiles({ projectId, nodes: [], chatSessions: [] });
    }, [cleanupCanvasFiles, projectId]);

    return {
        loadError,
        retryLoad: () => setLoadAttempt((attempt) => attempt + 1),
        addedSkills,
        clearCanvasFiles,
        createAndOpenProject,
        currentProject,
        deleteCurrentProject,
        renameCurrentProject,
        persistLocalCanvas,
        updateProject,
    };
}


function mergeHydratedSessions(currentSessions: CanvasAssistantSession[], hydratedSessions: CanvasAssistantSession[]) {
    const hydratedById = new Map(hydratedSessions.map((session) => [session.id, session]));
    return currentSessions.map((session) => {
        const hydrated = hydratedById.get(session.id);
        if (!hydrated) return session;
        const hydratedMessages = new Map(hydrated.messages.map((message) => [message.id, message]));
        return {
            ...session,
            messages: session.messages.map((message) => {
                const hydratedMessage = hydratedMessages.get(message.id);
                if (!hydratedMessage || !message.references?.length) return message;
                const hydratedReferences = new Map((hydratedMessage.references || []).map((reference) => [reference.id, reference]));
                return {
                    ...message,
                    references: message.references.map((reference) => {
                        const hydratedReference = hydratedReferences.get(reference.id);
                        return hydratedReference ? { ...reference, dataUrl: hydratedReference.dataUrl, storageKey: hydratedReference.storageKey } : reference;
                    }),
                };
            }),
        };
    });
}
