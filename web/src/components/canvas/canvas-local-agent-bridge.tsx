import { useEffect, useRef, useState } from "react";
import { Bot, X } from "lucide-react";

import {
    canvasOperationPostconditionMessage,
    hashCanvasSnapshot,
    verifyCanvasOperations,
    type CanvasOperation,
    type CanvasSnapshot,
} from "@/lib/canvas/canvas-operation-contract";
import { createClientId } from "@/lib/client-id";
import { isFilmAgentToolName, runFilmAgentTool } from "@/services/api/film-agent-tools";
import { isProjectAgentToolName, runProjectAgentTool } from "@/services/api/project-agent-tools";
import { getLocalRuntimeSessionClient, useLocalRuntimeStore } from "@/stores/use-local-runtime-store";

type RuntimeStateResult = {
    accepted?: boolean;
    revision?: number;
    stateHash?: string;
    reason?: string;
};

type ToolCallPayload = {
    requestId: string;
    name: string;
    input?: Record<string, unknown>;
};

type Props = {
    snapshot: CanvasSnapshot;
    onApplyOps: (ops?: CanvasOperation[], context?: { source?: "online" | "local"; conversationId?: string; messageId?: string }) => Promise<CanvasSnapshot>;
    open: boolean;
    onClose: () => void;
};

export function CanvasLocalAgentBridge({ snapshot, onApplyOps, open, onClose }: Props) {
    const clientIdRef = useRef(createClientId());
    const snapshotRef = useRef(snapshot);
    const applyOpsRef = useRef(onApplyOps);
    const connectedRef = useRef(false);
    const runtimeRevisionRef = useRef(0);
    const browserHashRef = useRef("");
    const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
    const syncSnapshotRef = useRef<(value: CanvasSnapshot) => void>(() => undefined);
    const syncTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [connection, setConnection] = useState<"idle" | "connecting" | "connected" | "error">("idle");

    useEffect(() => {
        applyOpsRef.current = onApplyOps;
    }, [onApplyOps]);

    useEffect(() => {
        snapshotRef.current = snapshot;
        if (!connectedRef.current) return;
        if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
        syncTimerRef.current = setTimeout(() => syncSnapshotRef.current(snapshot), 250);
        return () => {
            if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
        };
    }, [snapshot]);

    useEffect(() => {
        const controller = new AbortController();
        let retryDelay = 500;

        const syncRuntimeState = async (next: CanvasSnapshot, retry = false): Promise<void> => {
            const nextHash = hashCanvasSnapshot(next);
            const changed = Boolean(browserHashRef.current) && browserHashRef.current !== nextHash;
            const revision = changed ? runtimeRevisionRef.current + 1 : runtimeRevisionRef.current;
            const response = await getLocalRuntimeSessionClient().request(`/canvas/state?clientId=${encodeURIComponent(clientIdRef.current)}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ...next, clientId: clientIdRef.current, revision }),
            });
            const body = (await response.json().catch(() => ({}))) as RuntimeStateResult;
        if (response.status === 409 && !retry && typeof body.revision === "number") {
            // 新建/切换画布时，本地运行时里可能还留着上一个画布的状态；
            // 同一个 revision 会被判为冲突，所以直接前进一格再重试一次。
            runtimeRevisionRef.current = body.revision + 1;
            browserHashRef.current = "";
            return syncRuntimeState(next, true);
        }
            if (!response.ok || body.accepted !== true || typeof body.revision !== "number" || typeof body.stateHash !== "string") {
                throw new Error(body.reason || "画布状态同步失败");
            }
            runtimeRevisionRef.current = body.revision;
            browserHashRef.current = nextHash;
        };

        const enqueueStateSync = (next: CanvasSnapshot) => {
            syncQueueRef.current = syncQueueRef.current
                .catch(() => undefined)
                .then(() => syncRuntimeState(next))
                .then(() => undefined);
            return syncQueueRef.current;
        };
    syncSnapshotRef.current = (next) => {
        // 同步失败只影响本地 Agent 看到的画布快照，不应把未处理的 Promise 异常抛到页面上；
        // 下一次快照变化会重新排队重试。
        void enqueueStateSync(next).catch((error) => console.debug("[yingce-local-agent] 画布状态同步失败，将在下次变更时重试", error));
    };

        const postResult = async (payload: { requestId: string; result?: unknown; error?: string }) => {
            const response = await getLocalRuntimeSessionClient().request(`/canvas/result?clientId=${encodeURIComponent(clientIdRef.current)}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (!response.ok) throw new Error("本地 Agent 工具结果写回失败");
        };

        const runToolCall = async (payload: ToolCallPayload) => {
            try {
                const input = payload.input ?? {};
                if (payload.name === "canvas_apply_ops") {
                    if (typeof input.expectedRevision === "number" && input.expectedRevision !== runtimeRevisionRef.current) {
                        throw new Error(`画布 revision 已从 ${input.expectedRevision} 变为 ${runtimeRevisionRef.current}，请重新读取 canvas_get_context 后再执行写操作`);
                    }
                    const before = snapshotRef.current;
                    const ops = Array.isArray(input.ops) ? (input.ops as CanvasOperation[]) : [];
                    const next = await applyOpsRef.current(ops, { source: "local", conversationId: "codex-mcp", messageId: payload.requestId });
                    const verification = verifyCanvasOperations(before, next, ops);
                    const result = {
                        ok: verification.ok,
                        message: canvasOperationPostconditionMessage(verification),
                        data: { verification, snapshot: next },
                        snapshot: next,
                    };
                    snapshotRef.current = next;
                    await postResult({ requestId: payload.requestId, result });
                    await enqueueStateSync(next);
                    return;
                }
                if (isProjectAgentToolName(payload.name)) {
                    const result = await runProjectAgentTool(payload.name, input, snapshotRef.current.domainProjectId);
                    await postResult({ requestId: payload.requestId, result });
                    return;
                }
                // 影视流水线工具：调用页面同款的生成任务与提示词模板能力，不重新实现业务逻辑。
                if (isFilmAgentToolName(payload.name)) {
                    const input2 = { ...input };
                    if (!input2.projectId && snapshotRef.current.domainProjectId) input2.projectId = snapshotRef.current.domainProjectId;
                    const result = await runFilmAgentTool(payload.name, input2);
                    await postResult({ requestId: payload.requestId, result });
                    return;
                }
                throw new Error(`本地 Agent 不支持的工具：${payload.name}`);
            } catch (error) {
                const message = error instanceof Error ? error.message : "画布操作失败";
                await postResult({ requestId: payload.requestId, error: message }).catch(() => undefined);
            }
        };

        const consumeStream = async (lastEventId: { value: string }) => {
            const response = await getLocalRuntimeSessionClient().request(`/events?clientId=${encodeURIComponent(clientIdRef.current)}`, {
                method: "GET",
                headers: lastEventId.value ? { "Last-Event-ID": lastEventId.value } : undefined,
                signal: controller.signal,
            });
            if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
                throw new Error("本地 Canvas Agent 事件流不可用");
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8", { fatal: true });
            let buffer = "";
            let eventType = "";
            let eventId: string | undefined;
            let data: string[] = [];
            const dispatch = () => {
                if (!data.length) return;
                const type = eventType || "message";
                if (eventId) lastEventId.value = eventId;
                if (type === "hello") {
                    connectedRef.current = true;
                    setConnection("connected");
                    void enqueueStateSync(snapshotRef.current);
                } else if (type === "tool_call") {
                    try {
                        const payload = JSON.parse(data.join("\n")) as ToolCallPayload;
                        void runToolCall(payload);
                    } catch {
                        // Malformed optional events must not terminate the stream.
                    }
                }
                eventType = "";
                eventId = undefined;
                data = [];
            };
            const consumeLine = (line: string) => {
                if (!line) {
                    dispatch();
                    return;
                }
                if (line.startsWith(":")) return;
                const separator = line.indexOf(":");
                const field = separator < 0 ? line : line.slice(0, separator);
                const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
                if (field === "event") eventType = value;
                else if (field === "data") data.push(value);
                else if (field === "id" && !value.includes("\0")) eventId = value;
            };
            try {
                while (!controller.signal.aborted) {
                    const item = await reader.read();
                    if (item.done) break;
                    buffer += decoder.decode(item.value, { stream: true });
                    let newline = buffer.indexOf("\n");
                    while (newline >= 0) {
                        consumeLine(buffer.slice(0, newline).replace(/\r$/, ""));
                        buffer = buffer.slice(newline + 1);
                        newline = buffer.indexOf("\n");
                    }
                }
                buffer += decoder.decode();
                if (buffer) consumeLine(buffer.replace(/\r$/, ""));
                dispatch();
            } finally {
                await reader.cancel().catch(() => undefined);
                reader.releaseLock();
            }
        };

        const connectLoop = async () => {
            const lastEventId = { value: "" };
            while (!controller.signal.aborted) {
                try {
                    setConnection((current) => (current === "connected" ? current : "connecting"));
                    const runtime = useLocalRuntimeStore.getState();
                    if (runtime.connection !== "connected") {
                        await runtime.connect(controller.signal);
                    }
                    if (useLocalRuntimeStore.getState().connection !== "connected") {
                        throw new Error(useLocalRuntimeStore.getState().error || "本机 Canvas Agent 未连接");
                    }
                    await consumeStream(lastEventId);
                    if (!controller.signal.aborted) throw new Error("Canvas Agent 事件流已断开");
                } catch (error) {
            if (controller.signal.aborted) return;
            const hadConnection = connectedRef.current;
            connectedRef.current = false;
            setConnection("error");
            retryDelay = Math.min(retryDelay * 1.6, 8000);
            const message = error instanceof Error ? error.message : "本机 Canvas Agent 不可用";
            // 页面刚打开时本机会话还没建立，第一次握手失败属正常竞态，自动重试即可；
            // 只有“已经连上过再掉线”才算真正需要提醒的问题。
            if (hadConnection) console.warn(`[yingce-local-agent] ${message}`);
            else console.debug(`[yingce-local-agent] 连接重试：${message}`);
                    await new Promise<void>((resolve) => {
                        const timer = setTimeout(resolve, retryDelay);
                        controller.signal.addEventListener("abort", () => {
                            clearTimeout(timer);
                            resolve();
                        }, { once: true });
                    });
                }
            }
        };

        void connectLoop();
        return () => {
            controller.abort();
            connectedRef.current = false;
            syncSnapshotRef.current = () => undefined;
            if (syncTimerRef.current) {
                clearTimeout(syncTimerRef.current);
                syncTimerRef.current = undefined;
            }
            setConnection("idle");
        };
    }, [snapshot.projectId]);

    if (!open) return null;
    const connected = connection === "connected";
    return (
        <aside className="pointer-events-auto fixed bottom-4 right-4 z-[var(--z-modal-overlay)] w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-xl border bg-background shadow-2xl" aria-label="本地 Canvas Agent">
            <header className="flex items-center gap-2 border-b px-3 py-2.5">
                <span className="grid size-7 place-items-center rounded-md bg-foreground/5 text-foreground"><Bot className="size-4" /></span>
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">本地 Canvas Agent</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-foreground/55">
                        <span className={`size-1.5 rounded-full ${connected ? "bg-emerald-500" : connection === "connecting" ? "bg-amber-500" : "bg-red-500"}`} />
                        {connected ? "已连接，等待 Codex MCP 调用" : connection === "connecting" ? "正在连接本机运行时" : "未连接，请运行一键启动"}
                    </div>
                </div>
                <button type="button" className="rounded-md p-1.5 text-foreground/55 hover:bg-foreground/5" onClick={onClose} aria-label="关闭">
                    <X className="size-4" />
                </button>
            </header>
            <div className="space-y-2 px-3 py-3 text-xs leading-5 text-foreground/65">
                <div>运行时：<span className="font-mono text-foreground">http://127.0.0.1:17371</span></div>
                <div>画布：<span className="font-mono text-foreground">{snapshot.projectId}</span></div>
                {snapshot.domainProjectId ? <div>短剧项目：<span className="font-mono text-foreground">{snapshot.domainProjectId}</span></div> : null}
                <div>在 Codex 中使用 <span className="font-mono text-foreground">yingce</span> MCP 即可读取和修改当前画布。</div>
            </div>
        </aside>
    );
}
