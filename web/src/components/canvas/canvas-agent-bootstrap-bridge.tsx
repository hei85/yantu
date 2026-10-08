import { useEffect } from "react";
import { useNavigate } from "react-router";

import { createClientId } from "@/lib/client-id";
import { isProjectAgentToolName, runProjectAgentTool } from "@/services/api/project-agent-tools";
import { getLocalRuntimeSessionClient, useLocalRuntimeStore } from "@/stores/use-local-runtime-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

type ToolCallPayload = { requestId: string; name: string; input?: Record<string, unknown> };

export function CanvasAgentBootstrapBridge({ enabled }: { enabled: boolean }) {
    const navigate = useNavigate();
    const hydrated = useCanvasStore((state) => state.hydrated);

    useEffect(() => {
        if (!enabled || !hydrated) return;
        const controller = new AbortController();
        const clientId = createClientId();
        const handledRequests = new Set<string>();
        let retryDelay = 500;

        const postResult = async (payload: { requestId: string; result?: unknown; error?: string }) => {
            const response = await getLocalRuntimeSessionClient().request(`/canvas/result?clientId=${encodeURIComponent(clientId)}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (!response.ok) throw new Error("本地 Agent 工具结果写回失败");
        };

        const runToolCall = async (payload: ToolCallPayload) => {
            if (!payload.requestId || handledRequests.has(payload.requestId)) return;
            handledRequests.add(payload.requestId);
            try {
                if (payload.name !== "project_create_from_script" || !isProjectAgentToolName(payload.name)) {
                    throw new Error(`主页 Agent 暂不支持工具：${payload.name}`);
                }
                const result = await runProjectAgentTool(payload.name, payload.input ?? {});
                const canvasId = (result as { canvas?: { id?: unknown } }).canvas?.id;
                if (typeof canvasId !== "string" || !canvasId) throw new Error("项目已创建，但没有返回有效的画布 ID");
                await postResult({ requestId: payload.requestId, result });
                navigate(`/canvas/${encodeURIComponent(canvasId)}?agent=1`);
            } catch (error) {
                const message = error instanceof Error ? error.message : "主页 Agent 操作失败";
                await postResult({ requestId: payload.requestId, error: message }).catch((postError) => console.debug("[yingce-agent-bootstrap] 工具错误回报失败", postError));
            }
        };

        const consumeStream = async (lastEventId: { value: string }) => {
            const response = await getLocalRuntimeSessionClient().request(`/events?clientId=${encodeURIComponent(clientId)}`, {
                method: "GET",
                headers: lastEventId.value ? { "Last-Event-ID": lastEventId.value } : undefined,
                signal: controller.signal,
            });
            if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
                throw new Error("本地 Agent 事件流不可用");
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8", { fatal: true });
            let buffer = "";
            let eventType = "";
            let eventId: string | undefined;
            let data: string[] = [];
            const dispatch = () => {
                if (!data.length) return;
                if (eventId) lastEventId.value = eventId;
                if (eventType === "tool_call") {
                    try {
                        const payload = JSON.parse(data.join("\n")) as ToolCallPayload;
                        void runToolCall(payload);
                    } catch {
                        // Ignore malformed optional events and keep the stream alive.
                    }
                }
                eventType = "";
                eventId = undefined;
                data = [];
            };
            const consumeLine = (line: string) => {
                if (!line) return dispatch();
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
                    await useLocalRuntimeStore.getState().connect(controller.signal);
                    if (useLocalRuntimeStore.getState().connection !== "connected") {
                        throw new Error(useLocalRuntimeStore.getState().error || "本机 Agent 未连接");
                    }
                    await consumeStream(lastEventId);
                    if (!controller.signal.aborted) throw new Error("本地 Agent 事件流已断开");
                    retryDelay = 500;
                } catch (error) {
                    if (controller.signal.aborted) return;
                    console.debug("[yingce-agent-bootstrap] 连接重试", error);
                    await new Promise<void>((resolve) => {
                        const timer = setTimeout(resolve, retryDelay);
                        controller.signal.addEventListener("abort", () => {
                            clearTimeout(timer);
                            resolve();
                        }, { once: true });
                    });
                    retryDelay = Math.min(retryDelay * 1.6, 8000);
                }
            }
        };

        void connectLoop();
        return () => controller.abort();
    }, [enabled, hydrated, navigate]);

    return null;
}
