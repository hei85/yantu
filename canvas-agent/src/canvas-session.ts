import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerResponse } from "node:http";

import { buildCanvasContext, buildCanvasContextSummary, findCanvasNodes, getCanvasConnection, getCanvasGenerationTasks, getCanvasNode, getCanvasResources, hashState, validateCanvasOps } from "./canvas-context.js";
import { filmBindingResolutionHint, hydrateFilmPlanFromCanvasStoryboard } from "./film-storyboard-binding.js";
import { normalizeFilmModelCatalog } from "./model-catalog.js";
import { runtimeDiagnostics } from "./runtime-diagnostics.js";
import { auditFilmWorkflow, readQualityPluginReports } from "./film-self-check.js";
import { LocalCanvasFileTransfers } from "./local-file-transfer.js";
import { toolDescriptions, toolNames, type ToolName } from "./schemas.js";
import { compactCanvasState, compactNode, isToolName, nextCanvasX, parseToolInput } from "./tools.js";
import type { CanvasNode, CanvasNodeType, CanvasSnapshot } from "./types.js";

type PendingRequest = { clientId: string; canvasId?: string; resolve: (value: unknown) => void; reject: (error: Error) => void };
type CanvasClient = { response: ServerResponse; timer: NodeJS.Timeout; runtimeSessionId?: string };

export class CanvasSession {
    private clients = new Map<string, CanvasClient>();
    private pending = new Map<string, PendingRequest>();
    private localFileTransfers = new LocalCanvasFileTransfers();
    private statesByClientId = new Map<string, CanvasSnapshot>();
    private revisionFloorByCanvasId = new Map<string, number>();
    private clientContext = new AsyncLocalStorage<string>();

    private get canvasState(): CanvasSnapshot | null {
        const clientId = this.clientContext.getStore();
        if (clientId) return this.statesByClientId.get(clientId) || null;
        const states = [...this.statesByClientId.values()];
        return states.length === 1 ? states[0] : null;
    }

    health() {
        this.pruneClosedClients();
        return { ok: true, hasCanvas: this.statesByClientId.size > 0, clients: this.clients.size };
    }

    openEvents(url: URL, res: ServerResponse, runtimeSessionId?: string) {
        const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const previous = this.clients.get(clientId);
        if (previous) this.rejectPendingClient(clientId, new Error("画布连接已被同 clientId 的新标签连接替换"));
        sendEvent(res, "hello", { ok: true, clientId });
        const timer = setInterval(() => {
            if (res.destroyed || res.writableEnded) {
                if (this.clients.get(clientId)?.response === res) this.removeClient(clientId, new Error("画布连接已断开"));
                clearInterval(timer);
                return;
            }
            try { sendEvent(res, "ping", { time: Date.now() }); }
            catch {
                if (this.clients.get(clientId)?.response === res) this.removeClient(clientId, new Error("画布连接已断开"));
                clearInterval(timer);
            }
        }, 15000);
        this.clients.set(clientId, { response: res, timer, runtimeSessionId });
        if (previous) {
            clearInterval(previous.timer);
            previous.response.end();
        }
        res.on("close", () => {
            clearInterval(timer);
            if (this.clients.get(clientId)?.response !== res) return;
            this.clients.delete(clientId);
            this.statesByClientId.delete(clientId);
            this.rejectPendingClient(clientId, new Error("画布连接已断开"));
        });
    }

    closeRuntimeSession(runtimeSessionId: string) {
        const error = new Error("本机会话已撤销");
        for (const [clientId, client] of [...this.clients]) {
            if (client.runtimeSessionId !== runtimeSessionId) continue;
            this.clients.delete(clientId);
            clearInterval(client.timer);
            this.statesByClientId.delete(clientId);
            this.rejectPendingClient(clientId, error);
            client.response.end();
        }
        this.localFileTransfers.removeForRuntimeSession(runtimeSessionId);
    }

    streamLocalUpload(id: string, clientId: string, runtimeSessionId: string, res: ServerResponse) {
        this.localFileTransfers.streamOnce(id, clientId, runtimeSessionId, res);
    }

    updateState(body: unknown, clientId?: string) {
        this.pruneClosedClients();
        const resolvedClientId = clientId || (this.clients.size === 1 ? this.clients.keys().next().value : undefined);
        if (!resolvedClientId && this.clients.size > 1) return { accepted: false, revision: 0, stateHash: "", reason: "ambiguous_client" as const };
        if (clientId && this.clients.size > 0 && !this.clients.has(clientId)) return { accepted: false, revision: 0, stateHash: "", reason: "unknown_client" as const };
        const raw = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
        const candidate = { ...raw, ...(resolvedClientId ? { clientId: resolvedClientId } : {}) } as CanvasSnapshot;
        if (!candidate.projectId) return { accepted: false, revision: 0, stateHash: "", reason: "missing_canvas_id" as const };
        const incomingRevision = typeof candidate.revision === "number" && Number.isInteger(candidate.revision) && candidate.revision >= 0 ? candidate.revision : undefined;
        const actualHash = hashState(candidate);
        const suppliedHash = typeof (body as Record<string, unknown> | null)?.stateHash === "string" ? String((body as Record<string, unknown>).stateHash) : undefined;
        const previousState = resolvedClientId ? this.statesByClientId.get(resolvedClientId) : undefined;
        const sameCanvasPrevious = previousState?.projectId === candidate.projectId ? previousState : undefined;
        const currentRevision = sameCanvasPrevious?.revision ?? 0;
        if (suppliedHash && suppliedHash !== actualHash) return { accepted: false, revision: currentRevision, stateHash: sameCanvasPrevious ? hashState(sameCanvasPrevious) : actualHash, reason: "state_hash_mismatch" as const };
        if (sameCanvasPrevious) {
            if (incomingRevision !== undefined && incomingRevision < currentRevision) return { accepted: false, revision: currentRevision, stateHash: hashState(sameCanvasPrevious), reason: "stale_revision" as const };
            if (incomingRevision === currentRevision && actualHash !== hashState(sameCanvasPrevious)) return { accepted: false, revision: currentRevision, stateHash: hashState(sameCanvasPrevious), reason: "revision_conflict" as const };
        }
        const floor = this.revisionFloorByCanvasId.get(candidate.projectId) ?? -1;
        const revision = sameCanvasPrevious
            ? (incomingRevision ?? currentRevision + 1)
            : Math.max(incomingRevision ?? 0, floor + 1);
        if (resolvedClientId) this.statesByClientId.set(resolvedClientId, { ...candidate, revision });
        this.revisionFloorByCanvasId.set(candidate.projectId, Math.max(floor, revision));
        return { accepted: true, idempotent: Boolean(sameCanvasPrevious && incomingRevision === currentRevision && actualHash === hashState(sameCanvasPrevious)), revision, stateHash: actualHash };
    }

    resolveResult(body: { requestId?: string; error?: string; result?: unknown }, clientId: string) {
        const item = body.requestId ? this.pending.get(body.requestId) : null;
        if (!clientId || !item || !body.requestId || clientId !== item.clientId) return false;
        this.pending.delete(body.requestId);
        if (body.error) {
            item.reject(new Error(body.error));
            return true;
        }
        const snapshot = snapshotFromToolResult(body.result);
        if (snapshot) {
            const current = this.statesByClientId.get(item.clientId);
            if (!item.canvasId || snapshot.projectId !== item.canvasId || current?.projectId !== item.canvasId) {
                item.reject(new Error("异步画布结果属于不同或已切换的画布，已拒绝更新状态"));
                return true;
            }
            const revision = Math.max(typeof snapshot.revision === "number" ? snapshot.revision : 0, (current.revision ?? -1) + 1);
            const synchronized = this.updateState({ ...snapshot, revision }, item.clientId);
            if (!synchronized.accepted) {
                item.reject(new Error(`画布操作已返回，但回读快照与当前状态冲突（${synchronized.reason}）；请重新读取后核对`));
                return true;
            }
        }
        item.resolve(body.result);
        return true;
    }

    emitAll(type: string, payload: unknown) {
        this.clients.forEach((client) => sendEvent(client.response, type, payload));
    }

    dispose() {
        this.clients.forEach(({ response, timer }) => {
            clearInterval(timer);
            response.end();
        });
        this.clients.clear();
        this.statesByClientId.clear();
        this.localFileTransfers.dispose();
        const error = new Error("Canvas session disposed");
        this.pending.forEach((request) => request.reject(error));
        this.pending.clear();
    }

    async callTool(name: unknown, rawInput: unknown) {
        if (!isToolName(name)) throw new Error(`未知工具：${String(name)}`);
        const input = parseToolInput(name, rawInput) as Record<string, unknown>;
        const clientId = this.resolveClientForTool(name, input);
        return await this.clientContext.run(clientId || "", () => this.callToolScoped(name, rawInput));
    }

    private resolveClientForTool(tool: ToolName, input: Record<string, unknown>) {
        if (tool === "canvas_get_capabilities" || tool === "canvas_list_open_canvases") return "";
        const connectedStates = [...this.statesByClientId.entries()].filter(([clientId]) => this.clients.has(clientId));
        const explicitClientId = typeof input.clientId === "string" && input.clientId ? input.clientId : undefined;
        const isMutation = isMutatingTool(tool);
        const isCanvasWrite = tool.startsWith("canvas_") && !isCanvasReadOnlyTool(tool);
        const requestedCanvasId = isCanvasWrite
            ? (typeof input.expectedCanvasId === "string" ? input.expectedCanvasId : undefined)
            : (typeof input.canvasId === "string" ? input.canvasId : undefined);
        const requestedDomainProjectId = tool.startsWith("project_") || tool.startsWith("film_")
            ? (typeof input.projectId === "string" ? input.projectId : undefined)
            : undefined;

        if (tool === "project_create_from_script" && connectedStates.length === 0 && this.clients.size > 0) {
            if (explicitClientId && this.clients.has(explicitClientId)) return explicitClientId;
            if (this.clients.size > 1) throw new Error("ambiguous_client: 多个无画布状态的页面已连接，请显式传 clientId 或仅保留一个工作台");
            return this.clients.keys().next().value || "";
        }
        if (connectedStates.length === 0 && this.clients.size > 0) {
            throw new Error("canvas_state_required: 请先打开一张画布，再调用此工具");
        }

        if (explicitClientId) {
            const state = this.statesByClientId.get(explicitClientId);
            if (!this.clients.has(explicitClientId) || !state) throw new Error("unknown_client: 指定的画布 clientId 未连接或尚无状态");
            if (requestedCanvasId && state.projectId !== requestedCanvasId) throw new Error("canvas_mismatch: 指定 clientId 不属于请求的画布");
            if (isMutation && connectedStates.filter(([, candidate]) => candidate.projectId === state.projectId).length > 1) {
                throw new Error("same_canvas_multiple_clients: 同一画布有多个页面标签连接，写入已拒绝；请关闭重复标签后重试");
            }
            return explicitClientId;
        }

        let candidates = connectedStates;
        if (requestedCanvasId) candidates = candidates.filter(([, state]) => state.projectId === requestedCanvasId);
        if (requestedCanvasId && !candidates.length) throw new Error(`canvas_not_connected: 目标画布未连接：${requestedCanvasId}`);

        if (requestedDomainProjectId) {
            const associated = candidates.filter(([, state]) => state.domainProjectId === requestedDomainProjectId || state.projectId === requestedDomainProjectId);
            if (associated.length === 1) candidates = associated;
            else if (associated.length > 1) throw new Error("ambiguous_project_canvas: 多个画布关联此项目，请显式传 clientId 或 canvasId");
            else if (candidates.length > 1) throw new Error("ambiguous_project_canvas: 项目未唯一关联到已连接画布，请显式传 clientId 或 canvasId");
        }

        if (isCanvasWrite) {
            if (candidates.length > 1) throw new Error("same_canvas_multiple_clients: 同一画布有多个页面标签连接，写入已拒绝；请关闭重复标签后重试");
            if (!requestedCanvasId) throw new Error("expectedCanvasId is required to route a canvas write");
        }
        if (candidates.length > 1) throw new Error(requestedCanvasId ? "ambiguous_canvas_client: 同一画布连接了多个页面标签，请显式传 clientId" : "ambiguous_canvas: 多个画布已连接，请显式传 canvasId");
        if (candidates.length === 1) return candidates[0][0];

        if (requestedDomainProjectId && connectedStates.length === 1) return connectedStates[0][0];
        if (connectedStates.length === 1) return connectedStates[0][0];
        if (connectedStates.length > 1) throw new Error("ambiguous_canvas: 多个画布已连接，请显式传 canvasId");
        if (this.clients.size === 1 && !isMutation) return this.clients.keys().next().value || "";
        if (this.clients.size === 1 && isMutation) throw new Error("canvas_state_required: 当前页面尚未同步画布状态，拒绝路由写操作");
        if (this.clients.size > 1) throw new Error("ambiguous_client: 多个页面已连接，请显式传 clientId 或 canvasId");
        return "";
    }

    private async callToolScoped(name: unknown, rawInput: unknown) {
        if (!isToolName(name)) throw new Error(`未知工具：${String(name)}`);
        let tool: ToolName = name;
        let input = parseToolInput(tool, rawInput) as Record<string, unknown>;
        if (tool === "skill_prepare") input = { ...input, availableToolNames: [...toolNames] };
        const canvasWrite = tool.startsWith("canvas_") && !isCanvasReadOnlyTool(tool);
        const canvasPreconditions = canvasWrite ? {
            expectedCanvasId: input.expectedCanvasId,
            expectedRevision: input.expectedRevision,
            expectedStateHash: input.expectedStateHash,
        } : undefined;
        if (canvasWrite) {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            if (input.expectedCanvasId !== this.canvasState.projectId) {
                throw new Error(`目标画布不匹配：请求 ${String(input.expectedCanvasId)}，当前活动画布 ${String(this.canvasState.projectId)}；请重新读取 canvas_get_context`);
            }
            const current = buildCanvasContext(this.canvasState);
            if (input.expectedRevision !== current.revision || input.expectedStateHash !== current.stateHash) {
                throw new Error(`画布状态已变化（当前 revision=${current.revision}）；请重新读取 canvas_get_context 后重试`);
            }
        }
        if (tool === "canvas_upload_file" || tool === "canvas_import_project_archive") {
            if (!canvasPreconditions || typeof canvasPreconditions.expectedCanvasId !== "string" || typeof canvasPreconditions.expectedRevision !== "number" || typeof canvasPreconditions.expectedStateHash !== "string") throw new Error("缺少上传状态前置条件");
            const expectedCanvasId = canvasPreconditions.expectedCanvasId;
            const expectedRevision = canvasPreconditions.expectedRevision;
            const expectedStateHash = canvasPreconditions.expectedStateHash;
            const data = input as { filePath: string; nodeId?: string; x?: number; y?: number; preferLocal?: boolean };
            const targetCanvas = this.canvasState;
            if (!targetCanvas) throw new Error("当前没有已连接画布");
            const canvasId = targetCanvas.projectId;
            if (!canvasId) throw new Error("当前画布缺少 projectId");
            const clientId = targetCanvas.clientId || "";
            const client = this.clients.get(clientId);
            const runtimeSessionId = client?.runtimeSessionId;
            if (!runtimeSessionId) throw new Error("当前画布连接没有有效的浏览器本机会话，无法安全传输文件");
            const transfer = await this.localFileTransfers.create(data.filePath, { clientId, runtimeSessionId, canvasId });
            if (tool === "canvas_import_project_archive" && transfer.mimeType !== "application/zip") {
                this.localFileTransfers.discard(transfer.uploadId);
                throw new Error("项目导入仅接受 ZIP 文件");
            }
            const current = this.canvasState;
            const context = current ? buildCanvasContext(current) : null;
            if (!current || current.projectId !== expectedCanvasId || context?.revision !== expectedRevision || context?.stateHash !== expectedStateHash) {
                this.localFileTransfers.discard(transfer.uploadId);
                throw new Error("文件暂存期间画布状态已变化，请重新读取 canvas_get_context 后再上传");
            }
            try {
                return await this.requestCanvasTool(tool, {
                    expectedCanvasId,
                    expectedRevision,
                    expectedStateHash,
                    uploadId: transfer.uploadId,
                    fileName: transfer.fileName,
                    mimeType: transfer.mimeType,
                    size: transfer.size,
                    sha256: transfer.sha256,
                    nodeId: data.nodeId,
                    x: data.x,
                    y: data.y,
                    preferLocal: data.preferLocal,
                }, 5 * 60 * 1000);
            } finally {
                this.localFileTransfers.discard(transfer.uploadId);
            }
        }
        if (tool === "canvas_list_projects") return await this.requestCanvasTool(tool, input);
        if (tool === "canvas_read_quality_reports") {
            if (!this.canvasState) throw new Error("当前没有已连接画布");
            return { canvasId: this.canvasState.projectId, reports: readQualityPluginReports(this.canvasState, input.nodeIds), limitations: ["只复用实际报告；不会启动分析或宣称影片通过"] };
        }
        if (tool === "film_self_check") {
            if (!this.canvasState) throw new Error("当前没有已连接画布");
            return await auditFilmWorkflow(this.canvasState, input, {
                readRun: runId => this.requestCanvasTool("film_get_run", { runId }),
                probe: (resourceId, fullDecode) => this.requestCanvasTool("film_probe_media", { resourceId, fullDecode }, 180000),
            });
        }
        if (tool === "canvas_export_projects") return await this.requestCanvasTool(tool, input, 5 * 60 * 1000);
        if (tool === "canvas_get_timeline" || tool === "canvas_apply_timeline_operation") {
            if (!this.clients.size || !this.canvasState?.projectId) throw new Error("当前没有已连接画布");
            if (tool === "canvas_get_timeline") return await this.requestCanvasTool(tool, { projectId: this.canvasState.projectId });
            return await this.requestCanvasTool(tool, { ...input, projectId: this.canvasState.projectId });
        }
        if (tool === "canvas_convert_media") {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            return await this.requestCanvasTool(tool, input, 10 * 60 * 1000);
        }
        if (["canvas_crop_image", "canvas_split_image", "canvas_upscale_image", "canvas_extract_video_frames", "canvas_extract_video_audio", "canvas_trim_video"].includes(tool)) {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            return await this.requestCanvasTool(tool, input, 5 * 60 * 1000);
        }
        let storyboardWrite: { nodeId: string; rows: StoryboardRowData[]; requiredConnections: StoryboardConnection[]; requiredOutputMetadata: StoryboardOutputMetadata[] } | undefined;
        if (tool === "runtime_diagnostics") return runtimeDiagnostics(undefined, this.canvasState, this.health());
        if (tool === "canvas_list_open_canvases") {
            return [...this.statesByClientId.entries()]
                .filter(([clientId]) => this.clients.has(clientId))
                .map(([clientId, state]) => ({
                    canvasId: state.projectId,
                    title: typeof state.title === "string" ? state.title : "",
                    clientId,
                    revision: state.revision ?? 0,
                    stateHash: buildCanvasContext(state).stateHash,
                    domainProjectId: state.domainProjectId,
                }));
        }
        if (tool.startsWith("skill_")) {
            if (!this.clients.size) throw new Error("当前没有已连接的衍图页面，请先打开衍图工作台");
            return await this.requestCanvasTool(tool, input);
        }
        const projectTool = tool.startsWith("project_");
        // 影视流水线工具也交给衍图页面执行：那边才能用当前登录会话和真实生成链路。
        if (tool.startsWith("film_")) {
            if (!this.clients.size) throw new Error("当前没有已连接的衍图页面，请先打开衍图工作台");
            if (!input.projectId && this.canvasState?.domainProjectId) input.projectId = this.canvasState.domainProjectId;
            if (tool === "film_create_run" || tool === "film_update_plan") {
                input = hydrateFilmPlanFromCanvasStoryboard(input, this.canvasState);
                const bindingHint = filmBindingResolutionHint(input, this.canvasState);
                if (bindingHint) throw new Error(`productionSpec 缺少 film_list_models 返回的视频能力目录；现有素材只能复用，不能生成新片段${bindingHint}`);
            }
            const result = await this.requestCanvasTool(tool, input);
            return tool === "film_list_models" ? normalizeFilmModelCatalog(result) : result;
        }
        if (projectTool) {
            if (!this.clients.size || (!this.canvasState && tool !== "project_create_from_script")) throw new Error("当前没有已连接画布");
            if (!input.projectId && this.canvasState?.domainProjectId) input.projectId = this.canvasState.domainProjectId;
            if (!input.projectId && tool !== "project_create_from_script") throw new Error("当前画布没有关联短剧项目");
            return await this.requestCanvasTool(tool, input);
        }
        if (tool === "canvas_get_capabilities") {
            const toolCatalog = toolNames
                .filter((name) => name.startsWith("canvas_") || name.startsWith("project_") || name.startsWith("film_"))
                .map((name) => ({
                    name,
                    description: toolDescriptions[name],
                    group: name.startsWith("canvas_") ? "canvas" : name.startsWith("project_") ? "project" : "film",
                    availability: name === "project_create_from_script" ? "home_or_canvas" : "requires_connected_canvas",
                    status: name === "project_create_from_script" ? "bootstrap_from_home_or_canvas" : "requires_connected_canvas",
                }));
            return {
                tools: toolCatalog,
                operations: [
                    { type: "add_node", access: "write", reversible: true, cost: "none" },
                    { type: "update_node", access: "write", reversible: true, cost: "none" },
                    { type: "delete_node", access: "write", reversible: true, cost: "none" },
                    { type: "delete_connections", access: "write", reversible: true, cost: "none" },
                    { type: "connect_nodes", access: "write", reversible: true, cost: "none" },
                    { type: "set_viewport", access: "write", reversible: true, cost: "none" },
                    { type: "select_nodes", access: "write", reversible: true, cost: "none" },
                    { type: "run_generation", access: "write", reversible: false, cost: "may incur provider charges" },
                ],
                uiActions: [
                    { name: "canvas_edit_image", access: "write", reversible: false, cost: "may incur provider charges", shortSubmit: true, preflight: "canvas_preflight_image_edit" },
                    { name: "canvas_analyze_image", access: "write", reversible: false, cost: "may incur provider charges", shortSubmit: true },
                    { name: "canvas_decompose_image", access: "write", reversible: false, cost: "one provider task per layer", minLayers: 2, maxLayers: 6, shortSubmit: true },
                    { name: "canvas_annotate_image", access: "write", reversible: true, cost: "none" },
                    { name: "canvas_create_panorama_viewer", access: "write", reversible: true, cost: "none", reconstructsMissingViews: false },
                    { name: "canvas_save_node_asset", access: "write", reversible: true, cost: "none" },
                    { name: "canvas_image_node_action", access: "write", reversible: true, cost: "none" },
                    { name: "canvas_capture_director_frame", access: "write", reversible: true, cost: "none", opensMatchingDirectorWorkbench: true, view: "CAM", output: "single PNG still only", aspectRatio: "16:9" },
                    { name: "canvas_capture_director_video", access: "write", reversible: true, cost: "none", opensMatchingDirectorWorkbench: true, view: "CAM", durationSeconds: { min: 0.5, max: 30 }, output: "real-time WebM video only", aspectRatio: "16:9", timeoutMs: 180000, foregroundSensitive: true },
                    { name: "canvas_layout_nodes", reversible: true, cost: "none", preservesConnections: true },
                    { name: "canvas_undo_agent_ops", reversible: true, cost: "none", scope: "latest canvas-agent operation only" },
                    { name: "canvas_redo_agent_ops", reversible: true, cost: "none", scope: "latest canvas-agent undo only" },
                    { name: "canvas_duplicate_node", reversible: true, cost: "none", preservesInternalReferences: true },
                    { name: "canvas_toggle_node_locked", reversible: true, cost: "none" },
                    { name: "canvas_toggle_frame_collapsed", reversible: true, cost: "none" },
                    { name: "canvas_insert_asset", reversible: true, cost: "none", persistsExistingAssetReference: true },
                    { name: "canvas_replace_node_media", reversible: true, cost: "none", preservesNodeId: true },
                    { name: "canvas_export_color_grade", reversible: true, cost: "none", usesNativePngRenderer: true, createsDerivedImageResource: true },
                    { name: "canvas_set_panorama_view", access: "write", reversible: false, cost: "none", usesMountedNativeWebGLRenderer: true },
                    { name: "canvas_capture_panorama_view", access: "write", reversible: true, cost: "none", usesMountedNativeWebGLRenderer: true, createsDerivedImageResource: true },
                    { name: "canvas_inspect_node_render", access: "read", cost: "none", mountedDomOnly: true },
                    { name: "canvas_upload_file", reversible: true, cost: "none", maxBytes: 104857600, requiresLocalFilePath: true },
                    { name: "canvas_crop_image", reversible: true, cost: "none" },
                    { name: "canvas_split_image", reversible: true, cost: "none" },
                    { name: "canvas_upscale_image", reversible: true, cost: "none", algorithm: "local interpolation" },
                    { name: "canvas_extract_video_frames", reversible: true, cost: "none" },
                    { name: "canvas_extract_video_audio", reversible: true, cost: "none" },
                    { name: "canvas_trim_video", reversible: true, cost: "none", action: "extract" },
                    { name: "canvas_convert_media", reversible: true, cost: "none", operations: ["grayscale", "edge-canny", "lineart", "depth", "pose", "cutout"], requiresConnectedImageOrVideo: true },
                    { name: "canvas_batch_table_read", reversible: true, cost: "none" },
                    { name: "canvas_batch_table_add_row", reversible: true, cost: "none" },
                    { name: "canvas_batch_table_update_row", reversible: true, cost: "none" },
                    { name: "canvas_batch_table_remove_row", reversible: true, cost: "none" },
                    { name: "canvas_batch_table_add_reference_column", reversible: true, cost: "none" },
                    { name: "canvas_batch_table_remove_reference_column", reversible: true, cost: "none" },
                    { name: "canvas_batch_table_reorder_reference_columns", reversible: true, cost: "none" },
                    { name: "canvas_batch_table_move_reference_cell", reversible: true, cost: "none" },
                    { name: "canvas_batch_table_sync_rows_from_connections", reversible: true, cost: "none" },
                    { name: "canvas_edit_reference", reversible: true, cost: "none", preservesPromptMentions: true },
                    { name: "canvas_preflight_batch_rows", access: "read", cost: "none" },
                    { name: "canvas_generate_batch_rows", reversible: false, cost: "may incur provider charges", requiresUserConfirmation: true, idempotency: "clientOperationId" },
                    { name: "canvas_create_local_folder", reversible: true, cost: "none" },
                    { name: "canvas_create_storyboard_group", reversible: true, cost: "none" },
                    { name: "canvas_create_reference_group", reversible: true, cost: "none" },
                    { name: "canvas_move_nodes_to_frame", reversible: true, cost: "none" },
                    { name: "canvas_create_node", reversible: true, cost: "none", usesNativePageCreation: true },
                    { name: "canvas_get_drawing", access: "read", cost: "none", returnsNativeDocument: true },
                    { name: "canvas_update_drawing", reversible: false, cost: "none", engine: "excalidraw", operations: ["add_shape", "update_element", "delete_element"], invalidatesPreviewAndRender: true },
                    { name: "canvas_update_tldraw_drawing", reversible: false, cost: "none", engine: "tldraw", requiresLicense: true, operations: ["add_shape", "update_element", "delete_element"], invalidatesPreviewAndRender: true },
                    { name: "canvas_list_director_scenes", access: "read", cost: "none" },
                    { name: "canvas_get_director_scene", access: "read", cost: "none" },
                    { name: "canvas_create_director_shot", reversible: true, cost: "none", usesNativePageCreation: true },
                    { name: "canvas_update_director_scene", reversible: true, cost: "none", requiresSceneHash: true },
                    { name: "canvas_update_director_shot", reversible: true, cost: "none", requiresSceneHash: true },
                    { name: "canvas_add_director_camera", reversible: true, cost: "none", requiresSceneHash: true },
                    { name: "canvas_update_director_camera", reversible: true, cost: "none", requiresSceneHash: true },
                    { name: "canvas_delete_director_camera", reversible: true, cost: "none", requiresSceneHash: true, preservesOneCamera: true },
                    { name: "canvas_add_director_light", reversible: true, cost: "none", requiresSceneHash: true },
                    { name: "canvas_update_director_light", reversible: true, cost: "none", requiresSceneHash: true },
                    { name: "canvas_delete_director_light", reversible: true, cost: "none", requiresSceneHash: true },
                    { name: "canvas_add_director_object", reversible: true, cost: "none", requiresSceneHash: true },
                    { name: "canvas_update_director_object", reversible: true, cost: "none", requiresSceneHash: true },
                    { name: "canvas_delete_director_object", reversible: true, cost: "none", requiresSceneHash: true },
                    { name: "canvas_upsert_director_keyframe", reversible: true, cost: "none", requiresSceneHash: true },
                    { name: "canvas_delete_director_keyframe", reversible: true, cost: "none", requiresSceneHash: true },
                    { name: "canvas_upsert_director_bone_keyframe", reversible: true, cost: "none", requiresSceneHash: true },
                    { name: "canvas_delete_director_bone_keyframe", reversible: true, cost: "none", requiresSceneHash: true },
                    { name: "canvas_render_timeline", reversible: false, cost: "none", idempotency: "clientOperationId", usesNativeFFmpeg: true, requiresSubtitleBurn: true },
                    { name: "canvas_create_storyboard_image_nodes", reversible: true, cost: "none", submitsGeneration: false },
                    { name: "canvas_create_storyboard_video_nodes", reversible: true, cost: "none", submitsGeneration: false },
                    { name: "canvas_generate_storyboard_rows", reversible: false, cost: "may incur provider charges", requiresUserConfirmation: true, idempotency: "clientOperationId" },
                    { name: "canvas_find_available_assets", access: "read", cost: "none" },
                    { name: "canvas_preflight_storyboard_media", access: "read", cost: "none" },
                    { name: "canvas_generate_storyboard_media", reversible: true, cost: "may incur provider charges", requiresUserConfirmation: true, idempotency: "clientOperationId per-row batch" },
                    { name: "canvas_list_projects", access: "read" },
                    { name: "canvas_export_projects", access: "read+download", cost: "none", maxProjects: 100 },
                    { name: "canvas_import_project_archive", reversible: true, cost: "none", maxBytes: 104857600 },
                ],
                limitations: ["AI storyboard rows, per-row storyboard media, and batch-table row generation require a configured model and the product's explicit cost confirmation. Undo/redo apply only to the current in-memory canvas-agent history and are invalidated by unrelated canvas changes. Timeline, crop/split/upscale, color-grade PNG export, and video extraction are exposed; these local media operations do not call generation models. tldraw internal editing requires its configured License Key. Director CAM capture automatically opens the matching workbench in a 16:9 letterboxed view; browser focus and MediaRecorder support affect video recording. Visible timeline subtitles, text, and images use transparent PNG overlays; image clips accept PNG/JPEG/WebP and reject unsupported or undecodable sources."],
            };
        }
        if (tool === "canvas_generate_storyboard_rows") {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            return await this.requestCanvasTool(tool, input, 10 * 60 * 1000);
        }
        if (tool === "canvas_preflight_storyboard_media") {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            return await this.requestCanvasTool(tool, input);
        }
        if (tool === "canvas_generate_storyboard_media") {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            return await this.requestCanvasTool(tool, input, 10 * 60 * 1000);
        }
        if (tool === "canvas_preflight_batch_rows") {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            return await this.requestCanvasTool(tool, input);
        }
        if (tool === "canvas_generate_batch_rows") {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            return await this.requestCanvasTool(tool, input, 10 * 60 * 1000);
        }
        if (tool === "canvas_render_timeline") {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            return await this.requestCanvasTool(tool, input, 10 * 60 * 1000);
        }
        if (tool === "canvas_edit_reference") {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            validateReferenceOperationInput(input);
            return await this.requestCanvasTool(tool, input);
        }
        if (["canvas_add_director_camera", "canvas_update_director_camera", "canvas_delete_director_camera", "canvas_add_director_light", "canvas_update_director_light", "canvas_delete_director_light", "canvas_upsert_director_bone_keyframe", "canvas_delete_director_bone_keyframe"].includes(tool)) {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            return await this.requestCanvasTool(tool, input);
        }
        if (tool === "canvas_capture_director_frame") {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            const state = this.canvasState;
            const context = buildCanvasContext(state);
            if (input.expectedCanvasId !== state.projectId || input.expectedRevision !== context.revision || input.expectedStateHash !== context.stateHash) throw new Error("画布状态已变化，请重新读取 canvas_get_context 后重试");
            return await this.requestCanvasTool(tool, input);
        }
        if (tool === "canvas_capture_director_video") {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            const state = this.canvasState;
            const context = buildCanvasContext(state);
            if (input.expectedCanvasId !== state.projectId || input.expectedRevision !== context.revision || input.expectedStateHash !== context.stateHash) throw new Error("画布状态已变化，请重新读取 canvas_get_context 后重试");
            // Browser real-time capture is foreground-sensitive and may spend up to 30s recording
            // plus media upload/probe time; do not fail the caller at the generic 30s timeout.
            return await this.requestCanvasTool(tool, input, 180000);
        }
        if (tool === "canvas_export_color_grade") {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            const context = buildCanvasContext(this.canvasState);
            if (input.expectedCanvasId !== this.canvasState.projectId || input.expectedRevision !== context.revision || input.expectedStateHash !== context.stateHash) throw new Error("画布状态已变化，请重新读取 canvas_get_context 后导出调色结果");
            return await this.requestCanvasTool(tool, input, 180000);
        }
        if (tool === "canvas_set_panorama_view" || tool === "canvas_capture_panorama_view") {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            const context = buildCanvasContext(this.canvasState);
            if (input.expectedCanvasId !== this.canvasState.projectId || input.expectedRevision !== context.revision || input.expectedStateHash !== context.stateHash) throw new Error("画布状态已变化，请重新读取 canvas_get_context 后重试");
            return await this.requestCanvasTool(tool, input, tool === "canvas_capture_panorama_view" ? 180000 : undefined);
        }
        if (tool === "canvas_inspect_node_render") {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            return await this.requestCanvasTool(tool, input);
        }
        if (["canvas_get_drawing", "canvas_update_drawing", "canvas_update_tldraw_drawing", "canvas_list_director_scenes", "canvas_get_director_scene", "canvas_create_director_shot", "canvas_update_director_scene", "canvas_update_director_shot", "canvas_add_director_object", "canvas_update_director_object", "canvas_delete_director_object", "canvas_upsert_director_keyframe", "canvas_delete_director_keyframe", "canvas_layout_nodes", "canvas_undo_agent_ops", "canvas_redo_agent_ops", "canvas_duplicate_node", "canvas_toggle_node_locked", "canvas_toggle_frame_collapsed", "canvas_insert_asset", "canvas_replace_node_media", "canvas_export_color_grade", "canvas_set_panorama_view", "canvas_capture_panorama_view", "canvas_crop_image", "canvas_split_image", "canvas_upscale_image", "canvas_extract_video_frames", "canvas_extract_video_audio", "canvas_trim_video", "canvas_convert_media", "canvas_batch_table_read", "canvas_batch_table_add_row", "canvas_batch_table_update_row", "canvas_batch_table_remove_row", "canvas_batch_table_add_reference_column", "canvas_batch_table_remove_reference_column", "canvas_batch_table_reorder_reference_columns", "canvas_batch_table_move_reference_cell", "canvas_batch_table_sync_rows_from_connections", "canvas_create_local_folder", "canvas_create_storyboard_group", "canvas_create_reference_group", "canvas_move_nodes_to_frame", "canvas_create_node", "canvas_create_storyboard_image_nodes", "canvas_create_storyboard_video_nodes"].includes(tool)) {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            return await this.requestCanvasTool(tool, input);
        }
        const readTool = ["canvas_preflight_image_edit", "runtime_diagnostics", "canvas_get_state", "canvas_get_drawing", "canvas_list_director_scenes", "canvas_get_director_scene", "canvas_get_context", "canvas_find_nodes", "canvas_find_available_assets", "canvas_preflight_storyboard_media", "canvas_preflight_batch_rows", "canvas_get_node", "canvas_get_connection", "canvas_get_generation_tasks", "canvas_get_resources", "canvas_validate_ops", "canvas_get_selection", "canvas_export_snapshot", "canvas_inspect_node_render"].includes(tool);
        if (readTool && (!this.clients.size || !this.canvasState)) throw new Error("当前没有已连接画布");
        if (tool === "canvas_get_state" || tool === "canvas_export_snapshot") {
            const snapshot = compactCanvasState(this.canvasState);
            return { ...snapshot, stateHash: buildCanvasContext(this.canvasState).stateHash };
        }
        if (tool === "canvas_merge_videos") {
            if (!this.clients.size) throw new Error("当前没有已连接的衍图页面，请先打开衍图工作台");
            return await this.requestCanvasTool(tool, input);
        }
        if (isGenerationToolCall(tool, input)) {
            const identity = stableGenerationIdentity(tool, input, this.canvasState);
            input = { ...input, ...identity };
            const existing = this.canvasState?.nodes?.find((node) =>
                stringValue(node.metadata?.clientOperationId) === identity.clientOperationId
                || stringValue(node.metadata?.taskClientOperationId) === identity.clientOperationId,
            );
            if (existing) {
                const matchedPersistedTask = stringValue(existing.metadata?.taskClientOperationId) === identity.clientOperationId;
                const previousFingerprint = matchedPersistedTask && tool !== "canvas_edit_image" && tool !== "canvas_analyze_image" ? "" : stringValue(existing.metadata?.clientOperationFingerprint);
                if (previousFingerprint && previousFingerprint !== identity.clientOperationFingerprint) {
                    throw new Error("clientOperationId 已用于不同生成请求；请为新的生成请求提供新 ID");
                }
                const taskId = stringValue(existing.metadata?.taskId);
                const taskStatus = stringValue(existing.metadata?.taskStatus);
                const nodeStatus = stringValue(existing.metadata?.status);
                const hasSubmissionEvidence = matchedPersistedTask
                    || Boolean(taskId)
                    || ["pending", "queued", "running", "succeeded", "failed", "cancelled"].includes(taskStatus)
                    || ["loading", "success", "failed", "error"].includes(nodeStatus);
                if (hasSubmissionEvidence) {
                    return {
                        accepted: true,
                        idempotentReplay: true,
                        clientOperationId: identity.clientOperationId,
                        nodeId: existing.id,
                        taskId,
                        status: taskStatus || nodeStatus || "pending",
                    };
                }
            }
        }
        if (["canvas_preflight_image_edit", "canvas_edit_image", "canvas_analyze_image", "canvas_annotate_image", "canvas_decompose_image", "canvas_create_panorama_viewer", "canvas_save_node_asset", "canvas_image_node_action"].includes(tool)) {
            if (!this.clients.size || !this.canvasState) throw new Error("当前没有已连接画布");
            return await this.requestCanvasTool(tool, input);
        }
        if (tool === "canvas_get_storyboard") {
            if (!this.canvasState) throw new Error("当前没有已连接画布");
            if (typeof input.nodeId === "string") {
                const target = this.canvasState.nodes?.find((node) => node.id === input.nodeId);
                if (!target || target.type !== "script") throw new Error("canvas_get_storyboard 仅接受真实 Script 节点");
            }
            return readStoryboard(this.canvasState, input as { nodeId?: string });
        }
        if (tool === "canvas_update_storyboard") {
            const data = input as { nodeId?: string; mode?: "replace" | "merge" | "append"; expectedCanvasId: string; expectedRevision?: number; expectedStateHash?: string; rows: StoryboardRowData[] };
            const currentState = this.canvasState;
            if (!currentState) throw new Error("当前没有已连接画布");
            const target = resolveStoryboardNode(currentState, data.nodeId);
            if (!target) throw new Error("找不到可写入的 Script 分镜节点：先 canvas_get_storyboard 拿到节点 id，或创建 script 节点后再写分镜");
            if (target.type !== "script") throw new Error("分镜只能写入真实 Script 节点，拒绝修改其他节点类型");
            const currentContext = buildCanvasContext(currentState);
            const hasExpectedRevision = typeof data.expectedRevision === "number" && Number.isInteger(data.expectedRevision);
            const hasMatchingStateHash = typeof data.expectedStateHash === "string" && data.expectedStateHash === currentContext.stateHash;
            if (!hasExpectedRevision || (data.expectedRevision !== currentContext.revision && !hasMatchingStateHash)) {
                throw new Error(`画布 revision 已从 ${data.expectedRevision} 变为 ${currentContext.revision}，请重新读取 canvas_get_context 后再执行写操作`);
            }
            if (!hasMatchingStateHash) {
                throw new Error("画布状态已变化，请重新读取 canvas_get_context 后再执行写操作");
            }
            const current = storyboardOf(target);
            const storedRows = current?.rows || [];
            if ((data.mode || "merge") === "replace" && storedRows.length && data.rows.some((row) => !stringValue(row.id))) {
                throw new Error("replace 会覆盖已有分镜；必须从 canvas_get_storyboard 取回并保留每一行的稳定 rowId");
            }
            const rows = mergeStoryboardRows(storedRows, Array.isArray(data.rows) ? data.rows : [], data.mode || "merge");
            const binding = storyboardRowConnectionOps(currentState, target, storedRows.map((row, index) => normalizeStoryboardRow(row, index)), rows);
            const outputMetadata = storyboardPendingOutputMetadata(currentState, target, rows, binding.requiredConnections);
            input = {
                expectedCanvasId: data.expectedCanvasId,
                expectedRevision: currentContext.revision,
                expectedStateHash: currentContext.stateHash,
                ops: [
                    {
                        type: "update_node",
                        id: target.id,
                        metadata: {
                            storyboard: {
                                rows,
                visibleColumns: current?.visibleColumns.length ? current.visibleColumns : DEFAULT_STORYBOARD_COLUMNS,
                                referenceNodeIds: current?.referenceNodeIds || [],
                            },
                        },
                    },
                    ...outputMetadata.map((output) => ({
                        type: "update_node",
                        id: output.nodeId,
                        metadata: { prompt: output.prompt, composerContent: output.composerContent },
                    })),
                    ...binding.ops,
                ],
            };
            storyboardWrite = { nodeId: target.id, rows, requiredConnections: binding.requiredConnections, requiredOutputMetadata: outputMetadata };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_get_context") return input.detail === "summary"
            ? buildCanvasContextSummary(this.canvasState)
            : buildCanvasContext(this.canvasState);
        if (tool === "canvas_find_nodes") return findCanvasNodes(this.canvasState, input as Parameters<typeof findCanvasNodes>[1]);
        if (tool === "canvas_find_available_assets") return await this.requestCanvasTool(tool, input);
        if (tool === "canvas_get_node") return getCanvasNode(this.canvasState, input as Parameters<typeof getCanvasNode>[1]);
        if (tool === "canvas_get_connection") return getCanvasConnection(this.canvasState, input as Parameters<typeof getCanvasConnection>[1]);
        if (tool === "canvas_get_generation_tasks") return getCanvasGenerationTasks(this.canvasState, input as Parameters<typeof getCanvasGenerationTasks>[1]);
        if (tool === "canvas_get_resources") return getCanvasResources(this.canvasState, input as Parameters<typeof getCanvasResources>[1]);
        if (tool === "canvas_validate_ops") return validateCanvasOps(this.canvasState, (input as { ops: unknown[] }).ops);
        if (tool === "canvas_get_selection") {
            const ids = new Set(this.canvasState?.selectedNodeIds || []);
            return { nodes: (this.canvasState?.nodes || []).filter((node) => ids.has(node.id)).map(compactNode) };
        }
        if (tool === "canvas_create_workflow") {
            input = { ops: workflowOps(input as Record<string, unknown>, this.canvasState) };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_create_node") {
            const data = input as { nodeType: CanvasNodeType; title?: string; x?: number; y?: number; width?: number; height?: number; metadata?: Record<string, unknown> };
            input = { ops: [{ type: "add_node", nodeType: data.nodeType, title: data.title, position: { x: data.x ?? nextCanvasX(this.canvasState), y: data.y ?? 0 }, width: data.width, height: data.height, metadata: data.metadata }] };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_create_text_node") {
            const text = input as { text?: string; x?: number; y?: number; title?: string; width?: number; height?: number };
            input = { ops: [textNodeOp(text, text.x ?? nextCanvasX(this.canvasState), text.y ?? 0)] };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_create_text_nodes") {
            const data = input as { items: Array<{ text: string; title?: string; x?: number; y?: number; width?: number; height?: number }>; x?: number; y?: number; gap?: number; direction?: "row" | "column" };
            const batchText = data.items.map((item) => `${item.title || ""} ${item.text || ""}`).join(" ");
            if (/流水线|工作流|工作流图|管线|节点图|连线|pipeline|workflow/i.test(batchText)) throw new Error("检测到工作流意图，请使用 canvas_create_workflow 创建真实类型节点和连线");
            const x = Number(data.x ?? nextCanvasX(this.canvasState));
            const y = Number(data.y ?? 0);
            const gap = Number(data.gap ?? 40);
            input = {
                ops: data.items.map((item, index) => textNodeOp(item, item.x ?? (data.direction === "row" ? x + index * (340 + gap) : x), item.y ?? (data.direction === "row" ? y : y + index * (240 + gap)))),
            };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_create_image_prompt_flow") {
            input = { ops: generationFlowOps({ ...(input as Record<string, unknown>), mode: "image" }, this.canvasState) };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_create_generation_flow") {
            input = { ops: generationFlowOps(input as Record<string, unknown>, this.canvasState) };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_generate_text" || tool === "canvas_generate_image" || tool === "canvas_generate_video" || tool === "canvas_generate_audio") {
            input = { ops: generationFlowOps({ ...(input as Record<string, unknown>), mode: tool.replace("canvas_generate_", ""), autoRun: true }, this.canvasState) };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_update_node") {
            const data = input as { id: string; patch?: Record<string, unknown>; metadata?: Record<string, unknown> };
            input = { ops: [{ type: "update_node", id: data.id, patch: data.patch, metadata: data.metadata }] };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_update_node_text") {
            const data = input as { id: string; text: string; title?: string };
            input = { ops: [{ type: "update_node", id: data.id, patch: { ...(data.title ? { title: data.title } : {}) }, metadata: { content: data.text, status: "success" } }] };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_move_nodes") {
            const data = input as { items: Array<{ id: string; x?: number; y?: number; dx?: number; dy?: number }> };
            input = {
                ops: data.items.map((item) => {
                    const current = findNode(this.canvasState, item.id);
                    return { type: "update_node", id: item.id, patch: { position: { x: item.x ?? ((current?.position.x || 0) + (item.dx || 0)), y: item.y ?? ((current?.position.y || 0) + (item.dy || 0)) } } };
                }),
            };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_resize_node") {
            const data = input as { id: string; width: number; height: number; freeResize?: boolean };
            input = { ops: [{ type: "update_node", id: data.id, patch: { width: data.width, height: data.height }, metadata: data.freeResize === undefined ? undefined : { freeResize: data.freeResize } }] };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_delete_nodes") {
            const ids = (input as { ids: string[] }).ids;
            const orphanConnectionIds = orphanedStoryboardConnectionIds(this.canvasState, ids);
            input = {
                ops: [
                    ...(orphanConnectionIds.length ? [{ type: "delete_connections", ids: orphanConnectionIds }] : []),
                    { type: "delete_node", ids },
                ],
            };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_connect_nodes") {
            const data = input as { connections: Array<{ fromNodeId: string; toNodeId: string; fromHandleId?: string; toHandleId?: string }> };
            input = { ops: data.connections.map((connection) => ({ type: "connect_nodes", ...connection })) };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_select_nodes") {
            input = { ops: [{ type: "select_nodes", ids: (input as { ids: string[] }).ids }] };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_set_viewport") {
            input = { ops: [{ type: "set_viewport", viewport: (input as { viewport: unknown }).viewport }] };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_run_generation") {
            const data = input as { nodeId: string; mode?: string; prompt?: string; retry?: boolean; clientOperationId?: string };
            input = { ops: [runGenerationOp(data.nodeId, generationMode(data.mode), data.prompt, data.retry, data.clientOperationId)] };
            tool = "canvas_apply_ops";
        }
        if (tool !== "canvas_apply_ops") throw new Error(`未知工具：${tool}`);
        if (canvasPreconditions) input = { ...input, ...canvasPreconditions };
        input = withGenerationOperationIds(tool, input, this.canvasState);
        if (!this.clients.size) throw new Error("当前没有已连接画布");
        const currentContext = buildCanvasContext(this.canvasState);
        const expectedRevision = typeof input.expectedRevision === "number" ? input.expectedRevision : undefined;
        const expectedStateHash = typeof input.expectedStateHash === "string" ? input.expectedStateHash : "";
        const hasMatchingStateHash = Boolean(expectedStateHash) && expectedStateHash === currentContext.stateHash;
        if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || (expectedRevision !== currentContext.revision && !hasMatchingStateHash))) {
            throw new Error(`画布 revision 已从 ${expectedRevision} 变为 ${currentContext.revision}，请重新读取 canvas_get_context 后再执行写操作`);
        }
        if (expectedStateHash && expectedStateHash !== currentContext.stateHash) {
            throw new Error("画布状态已变化，请重新读取 canvas_get_context 后再执行写操作");
        }
        const validation = validateCanvasOps(this.canvasState, (input as { ops: unknown[] }).ops);
        if (!validation.ok) throw new Error(`画布操作校验失败：${validation.issues.filter((item) => item.severity === "error").map((item) => item.message).join("；")}`);
        const applied = await this.requestCanvasTool(tool, input);
        if (!storyboardWrite) return applied;
        if (isRecord(applied) && applied.ok === false) {
            throw new Error(typeof applied.message === "string" ? applied.message : "分镜表写入未通过画布回读校验");
        }
        const persistedState = this.canvasState;
        if (!persistedState) throw new Error("分镜写入后没有可回读的画布状态");
        const persistedNode = persistedState.nodes?.find((node) => node.id === storyboardWrite?.nodeId);
        const persisted = persistedNode ? storyboardOf(persistedNode) : null;
        if (!persisted || JSON.stringify(persisted.rows) !== JSON.stringify(storyboardWrite.rows)) {
            throw new Error("分镜写入后回读与提交内容不一致；请重新读取画布后核对，未确认写入成功");
        }
        const missingConnections = storyboardWrite.requiredConnections.filter((expected) => !persistedState.connections?.some((connection) => sameStoryboardConnection(connection, expected)));
        if (missingConnections.length) {
            throw new Error(`分镜行级连线回读缺失 ${missingConnections.length} 条；请重新读取画布后核对`);
        }
        const staleOutputMetadata = storyboardWrite.requiredOutputMetadata.filter((expected) => {
            const node = persistedState.nodes?.find((candidate) => candidate.id === expected.nodeId);
            return node?.metadata?.prompt !== expected.prompt || node.metadata?.composerContent !== expected.composerContent;
        });
        if (staleOutputMetadata.length) {
            throw new Error(`分镜输出提示词回读缺失 ${staleOutputMetadata.length} 项；请重新读取画布后核对`);
        }
        return {
            ...(isRecord(applied) ? applied : { result: applied }),
            readback: readStoryboard(persistedState, { nodeId: storyboardWrite.nodeId }),
        };
    }

    private async requestCanvasTool(name: ToolName, input: Record<string, unknown>, timeoutMs = 30000) {
        const requestId = crypto.randomUUID();
        const clientId = this.clientContext.getStore();
        const client = clientId ? this.clients.get(clientId)?.response : undefined;
        if (!clientId || !client) throw new Error("当前没有已连接画布");
        const canvasId = this.statesByClientId.get(clientId)?.projectId;
        sendEvent(client, "tool_call", { requestId, name, input });
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                const operationIds = generationOperationIds(input);
                reject(new Error(name === "canvas_generate_storyboard_rows"
                    ? `AI 拆镜等待超时（requestId=${requestId}, clientOperationId=${String(input.clientOperationId || "")}, operation state uncertain）；先用相同 clientOperationId 重试以恢复任务，切勿换 ID 或重复确认`
                    : name === "canvas_generate_storyboard_media"
                    ? `分镜逐行媒体生成等待超时（requestId=${requestId}, clientOperationId=${String(input.clientOperationId || "")}, batch state uncertain）；先用相同 clientOperationId 查询/恢复，切勿换 ID 重提`
                    : name === "canvas_generate_batch_rows"
                    ? `批量表逐行生成等待超时（requestId=${requestId}, clientOperationId=${String(input.clientOperationId || "")}, batch state uncertain）；先用相同 clientOperationId 查询/恢复，切勿换 ID 重提`
                    : operationIds.length
                    ? `画布操作超时；生成状态不确定，clientOperationId=${operationIds.join(",")}。先查询画布任务并复用同一 ID，不要换新 ID 重发`
                    : `画布操作超时（requestId=${requestId}）；页面操作可能已产生资源或节点副作用。先读取画布与资源核对，再决定是否重试`));
            }, timeoutMs);
            this.pending.set(requestId, { clientId, canvasId, resolve: (value) => (clearTimeout(timer), resolve(value)), reject: (error) => (clearTimeout(timer), reject(error)) });
        });
    }

    private rejectPendingClient(clientId: string, error: Error) {
        for (const [requestId, request] of this.pending) {
            if (request.clientId !== clientId) continue;
            this.pending.delete(requestId);
            request.reject(error);
        }
    }

    private removeClient(clientId: string, error: Error) {
        const client = this.clients.get(clientId);
        if (!client) return;
        this.clients.delete(clientId);
        clearInterval(client.timer);
        this.statesByClientId.delete(clientId);
        this.rejectPendingClient(clientId, error);
    }

    private pruneClosedClients() {
        for (const [clientId, client] of [...this.clients]) {
            if (!client.response.destroyed && !client.response.writableEnded) continue;
            this.removeClient(clientId, new Error("画布连接已断开"));
        }
    }
}

function sendEvent(res: ServerResponse, type: string, payload: unknown) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function workflowOps(input: Record<string, unknown>, state: CanvasSnapshot | null) {
    const nodes = Array.isArray(input.nodes) ? input.nodes as Array<Record<string, unknown>> : [];
    if (!nodes.length) throw new Error("工作流至少需要一个节点");
    const refs = new Set<string>();
    for (const node of nodes) {
        const ref = String(node.ref || "").trim();
        const title = String(node.title || "").trim();
        const kind = String(node.kind || "text");
        const prompt = String(node.prompt || node.content || workflowPrompt(kind, title, input)).trim();
        if (!ref || !title) throw new Error("工作流节点必须包含 ref 和 title");
        if (refs.has(ref)) throw new Error(`工作流节点 ref「${ref}」重复`);
        if (!["text", "script"].includes(workflowNodeType(kind)) && !prompt) throw new Error(`媒体工作流节点「${title}」缺少 prompt/content，不能创建空资源节点`);
        refs.add(ref);
        for (const nodeId of Array.isArray(node.referenceNodeIds) ? node.referenceNodeIds : []) {
            if (!existingNodeId(state, String(nodeId))) throw new Error(`节点「${title}」引用的现有节点「${String(nodeId)}」不存在`);
        }
    }
    const direction = input.direction === "vertical" ? "vertical" : "horizontal";
    const gap = Math.max(48, Number(input.gap || 120));
    const existing = state?.nodes || [];
    const maxX = existing.reduce((max, node) => Math.max(max, node.position.x + node.width), 0);
    const maxY = existing.reduce((max, node) => Math.max(max, node.position.y + node.height), 0);
    const start = input.start && typeof input.start === "object" ? input.start as { x: number; y: number } : { x: existing.length ? maxX + 160 : 80, y: existing.length ? Math.max(80, maxY - 520) : 80 };
    const ids = new Map(nodes.map((node) => [String(node.ref), `agent-workflow-${slug(String(node.ref))}-${crypto.randomUUID().slice(0, 8)}`]));
    const ops: Array<Record<string, unknown>> = [];
    let cursor = { x: Number(start.x), y: Number(start.y) };
    for (const node of nodes) {
        const kind = String(node.kind || "text");
        const type = workflowNodeType(kind);
        const size = workflowNodeSize(type, kind, node.width, node.height);
        const prompt = String(node.prompt || node.content || workflowPrompt(kind, String(node.title), input));
        const position = { ...cursor };
        const internalReferenceIds = Array.isArray(node.referenceRefs) ? node.referenceRefs.map((ref) => ids.get(String(ref))).filter(Boolean) : [];
        const externalReferenceIds = Array.isArray(node.referenceNodeIds) ? node.referenceNodeIds.map(String) : [];
        ops.push({ type: "add_node", id: ids.get(String(node.ref)), nodeType: type, title: String(node.title), position, width: size.width, height: size.height, metadata: { content: type === "text" ? String(node.content || prompt) : "", composerContent: prompt || undefined, prompt: prompt || undefined, workflowKind: workflowKind(kind), workflowTitle: input.title, workflowDescription: node.description || input.description, generationMode: type === "image" ? "image" : type === "video" ? "video" : type === "audio" ? "audio" : undefined, status: type === "text" || type === "script" ? "success" : "idle", referenceNodeIds: [...internalReferenceIds, ...externalReferenceIds].length ? [...internalReferenceIds, ...externalReferenceIds] : undefined } });
        cursor = direction === "vertical" ? { x: Number(start.x), y: cursor.y + size.height + gap } : { x: cursor.x + size.width + gap, y: Number(start.y) };
    }
    const edges = Array.isArray(input.edges) && input.edges.length ? input.edges as Array<Record<string, unknown>> : nodes.slice(0, -1).map((node, index) => ({ from: node.ref, to: nodes[index + 1].ref }));
    const keys = new Set<string>();
    for (const edge of edges) {
        const from = String(edge.from || "");
        const to = String(edge.to || "");
        if (!ids.has(from) || !ids.has(to)) throw new Error(`工作流连线引用不存在的节点：${from} → ${to}`);
        const key = `${from}\0${to}`;
        if (keys.has(key)) continue;
        keys.add(key);
        ops.push({ type: "connect_nodes", fromNodeId: ids.get(from), toNodeId: ids.get(to) });
    }
    for (const node of nodes) for (const ref of Array.isArray(node.referenceRefs) ? node.referenceRefs : []) {
        const from = String(ref);
        const to = String(node.ref);
        if (!ids.has(from)) throw new Error(`节点「${to}」引用了不存在的节点「${from}」`);
        const key = `${from}\0${to}`;
        if (keys.has(key)) continue;
        keys.add(key);
        ops.push({ type: "connect_nodes", fromNodeId: ids.get(from), toNodeId: ids.get(to) });
    }
    for (const node of nodes) for (const ref of Array.isArray(node.referenceNodeIds) ? node.referenceNodeIds : []) {
        const from = String(ref);
        const to = String(node.ref);
        const key = `${from}\0${to}`;
        if (keys.has(key)) continue;
        keys.add(key);
        ops.push({ type: "connect_nodes", fromNodeId: from, toNodeId: ids.get(to) });
    }
    ops.push({ type: "select_nodes", ids: nodes.map((node) => ids.get(String(node.ref))) });
    if (input.autoRun === true || nodes.some((node) => node.runGeneration === true)) for (const node of nodes) {
        const type = workflowNodeType(String(node.kind || "text"));
        if (!["image", "video", "audio"].includes(type) || (input.autoRun !== true && node.runGeneration !== true)) continue;
        ops.push({ type: "run_generation", nodeId: ids.get(String(node.ref)), mode: type, prompt: node.prompt || node.content || workflowPrompt(String(node.kind || "text"), String(node.title), input) });
    }
    return ops;
}

function existingNodeId(state: CanvasSnapshot | null, id: string) {
    return Boolean(state?.nodes?.some((node) => node.id === id));
}

function workflowNodeType(kind: string) {
    if (kind === "script") return "script";
    if (["image", "character_cards", "character_three_view"].includes(kind)) return "image";
    if (["video", "storyboard_video"].includes(kind)) return "video";
    if (kind === "audio") return "audio";
    return "text";
}

function workflowNodeSize(type: string, kind: string, width: unknown, height: unknown) {
    const defaults = type === "image" ? { width: 560, height: 380 } : type === "video" ? { width: 640, height: 360 } : type === "script" ? { width: 920, height: 360 } : type === "audio" ? { width: 340, height: 160 } : { width: 420, height: 240 };
    return { width: typeof width === "number" && width > 0 ? width : defaults.width, height: typeof height === "number" && height > 0 ? height : defaults.height };
}

function workflowPrompt(kind: string, title: string, input: Record<string, unknown>) {
    const workflowTitle = String(input.title || input.description || "当前创作项目").trim();
    if (kind === "character_cards") return `请基于「${workflowTitle}」拆分主要角色，并为每个角色生成可用于后续创作的角色图片卡片：外观、服饰、身份、性格和视觉辨识点。`;
    if (kind === "character_three_view") return `请基于上游角色卡片生成「${title}」：同一角色的正面、侧面、背面三视图，保持服饰、发型、道具和比例一致。`;
    if (kind === "storyboard_video") return `请基于上游角色三视图，为「${workflowTitle}」制作分镜剧情视频方案：包含镜头顺序、景别、动作、节奏和画面连续性。`;
    return "";
}

function workflowKind(kind: string) {
    if (["character_cards", "character_three_view"].includes(kind)) return "character";
    if (kind === "storyboard_video") return "storyboard";
    if (kind === "script") return "script";
    return "free";
}

function slug(value: string) {
    return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "node";
}

function textNodeOp(input: { id?: string; text?: string; title?: string; width?: number; height?: number }, x: number, y: number) {
    return { type: "add_node", id: input.id, nodeType: "text", title: input.title, position: { x, y }, width: input.width, height: input.height, metadata: { content: input.text || "", status: "success", fontSize: 14 } };
}

function generationTargetNodeOp(id: string, input: Record<string, unknown>, x: number, y: number) {
    const mode = generationMode(input.mode);
    const prompt = String(input.prompt || "");
    // 空提示词会让节点创建成功、但提交静默失败（实测：“生成流程结束，但没有创建可追踪的任务”）。
    // 这里直接拒绝，给出可修正的错误，而不是让调用方以为已经提交。
    if (!prompt.trim() && mode !== "text") {
        throw new Error(`生成节点缺少提示词：${mode} 生成必须先写清 prompt（例如画面描述/动作/运镜），不能提交空提示词`);
    }
    const nodeType = generationNodeType(mode);
    const isVideo = nodeType === "video";
    const startFrameNodeId = isVideo ? stringValue(input.videoStartFrameNodeId) : "";
    const endFrameNodeId = isVideo ? stringValue(input.videoEndFrameNodeId) : "";
    const videoOperation = isVideo
        ? stringValue(input.videoOperation) || (startFrameNodeId || endFrameNodeId ? "image_to_video" : "")
        : "";
    const videoSeconds = input.videoSeconds ?? input.seconds;
    const videoRatio = input.videoRatio ?? input.size;
    const videoResolution = input.videoResolution ?? input.vquality;
    return {
        type: "add_node",
        id,
        nodeType,
        title: String(input.title || generationTitle(mode)),
        position: { x, y },
        width: typeof input.width === "number" ? input.width : undefined,
        height: typeof input.height === "number" ? input.height : undefined,
        metadata: cleanRecord({
            content: "",
            fontSize: nodeType === "text" ? 14 : undefined,
            generationMode: mode,
            composerContent: prompt,
            prompt,
            status: "idle",
            model: input.model,
            size: isVideo ? videoRatio : input.size,
            quality: input.quality,
            transparentBackground: input.transparentBackground,
            count: input.count,
            seconds: videoSeconds === undefined ? undefined : String(videoSeconds),
            vquality: isVideo ? videoResolution : input.vquality,
            generateAudio: input.generateAudio,
            watermark: input.watermark,
            audioVoice: input.audioVoice,
            audioFormat: input.audioFormat,
            audioSpeed: input.audioSpeed,
            audioInstructions: input.audioInstructions,
            videoEditOperation: videoOperation || undefined,
            videoStartFrameNodeId: startFrameNodeId || undefined,
            videoEndFrameNodeId: endFrameNodeId || undefined,
            clientOperationId: input.clientOperationId,
            clientOperationFingerprint: input.clientOperationFingerprint,
        }),
    };
}

export function generationFlowOps(input: Record<string, unknown>, state: CanvasSnapshot | null) {
    const mode = generationMode(input.mode);
    const prompt = String(input.prompt || "");
    // 目标节点收到的是 @[node:...] 引用而不一定是原文，所以必须在构建引用之前校验原始提示词：
    // 空提示词会让节点创建成功、但提交静默失败（实测：“生成流程结束，但没有创建可追踪的任务”）。
    if (!prompt.trim() && mode !== "text") {
        throw new Error(`生成节点缺少提示词：${mode} 生成必须先写清 prompt（例如画面描述/动作/运镜），不能提交空提示词`);
    }
    const clientOperationId = stringValue(input.clientOperationId);
    const suffix = clientOperationId ? crypto.createHash("sha256").update(clientOperationId).digest("hex").slice(0, 16) : crypto.randomUUID();
    const textId = `text-${suffix}`;
    // Text generation has both a prompt Text node and a generated Text target;
    // their IDs must describe distinct roles even though their node type matches.
    const targetId = mode === "text" ? `text-output-${suffix}` : `${mode}-${suffix}`;
    const explicitFrameIds = mode === "video"
        ? [stringValue(input.videoStartFrameNodeId), stringValue(input.videoEndFrameNodeId)].filter(Boolean)
        : [];
    if (explicitFrameIds.length && input.videoOperation === "text_to_video") {
        throw new Error("text_to_video 不能同时指定首帧或尾帧节点");
    }
    const referenceNodeIds = [...new Set([
        ...(Array.isArray(input.referenceNodeIds) ? input.referenceNodeIds.filter((id): id is string => typeof id === "string") : []),
        ...explicitFrameIds,
    ])];
    const tokens = [`@[node:${textId}]`, ...referenceNodeIds.map((id) => `@[node:${id}]`)];
    const targetInput = { ...input, prompt: tokens.join("\n") };
    // 摆放：有参考/首帧节点时贴着它生成，找不到才退回到画布最右侧光标；
    // 这样批量生成不会把新节点丢到几万像素之外。
    const placement = resolveGenerationPlacement(input, state, referenceNodeIds);
    const x = placement.x;
    const y = placement.y;
    return [
        textNodeOp({ id: textId, text: prompt, title: String(input.title || "提示词") }, x, y),
        generationTargetNodeOp(targetId, targetInput, x + 420, y),
        { type: "connect_nodes", fromNodeId: textId, toNodeId: targetId },
        ...referenceNodeIds.map((fromNodeId) => ({ type: "connect_nodes", fromNodeId, toNodeId: targetId })),
        { type: "select_nodes", ids: [targetId] },
        ...(input.autoRun ? [runGenerationOp(targetId, mode, tokens.join("\n"), false, clientOperationId)] : []),
    ];
}

const GENERATION_PLACEMENT_GAP = 160;
const GENERATION_PLACEMENT_GROUP_WIDTH = 420;

// 生成节点摆放：给了参考节点（首帧/参考图）就贴着它右侧生成，
// 只有没有可参考的节点时才退回画布最右侧光标，避免批量生成把节点丢到几万像素外。
export function resolveGenerationPlacement(
    input: Record<string, unknown>,
    state: CanvasSnapshot | null,
    referenceNodeIds: string[],
): { x: number; y: number } {
    const explicitX = Number(input.x);
    const explicitY = Number(input.y);
    if (Number.isFinite(explicitX) || Number.isFinite(explicitY)) {
        return {
            x: Number.isFinite(explicitX) ? explicitX : nextCanvasX(state),
            y: Number.isFinite(explicitY) ? explicitY : 0,
        };
    }
    const nodes = state?.nodes || [];
    const anchor = referenceNodeIds
        .map((id) => nodes.find((node) => node.id === id))
        .find((node) => Boolean(node));
    if (!anchor) return { x: nextCanvasX(state), y: 0 };
    const baseX = anchor.position.x + (anchor.width || 340) + GENERATION_PLACEMENT_GAP;
    const groupHeight = Math.max(anchor.height || 240, 280);
    let candidateY = anchor.position.y;
    for (let attempt = 0; attempt <= nodes.length; attempt += 1) {
        const collisions = nodes.filter((node) => generationPlacementOverlaps(baseX, candidateY, GENERATION_PLACEMENT_GROUP_WIDTH + GENERATION_PLACEMENT_GAP, groupHeight, node));
        if (!collisions.length) break;
        candidateY = Math.max(...collisions.map((node) => node.position.y + (node.height || 240) + 40));
    }
    return { x: baseX, y: candidateY };
}

function generationPlacementOverlaps(
    x: number,
    y: number,
    width: number,
    height: number,
    node: { position: { x: number; y: number }; width?: number; height?: number },
) {
    return !(
        x + width <= node.position.x ||
        x >= node.position.x + (node.width || 240) ||
        y + height <= node.position.y ||
        y >= node.position.y + (node.height || 240)
    );
}

function generationNodeType(mode: "text" | "image" | "video" | "audio"): CanvasNodeType {
    if (mode === "text") return "text";
    if (mode === "video") return "video";
    if (mode === "audio") return "audio";
    return "image";
}

function runGenerationOp(nodeId: string, mode: "text" | "image" | "video" | "audio", prompt?: string, retry?: boolean, clientOperationId?: string) {
    return { type: "run_generation", nodeId, mode, prompt, ...(retry ? { retry: true } : {}), ...(clientOperationId ? { clientOperationId } : {}) };
}

function isGenerationToolCall(tool: ToolName, input: Record<string, unknown>) {
    return tool === "canvas_edit_image" || tool === "canvas_analyze_image" || tool === "canvas_generate_text" || tool === "canvas_generate_image" || tool === "canvas_generate_video" || tool === "canvas_generate_audio"
        || (tool === "canvas_create_generation_flow" && input.autoRun === true)
        || (tool === "canvas_create_image_prompt_flow" && input.autoRun === true)
        || tool === "canvas_run_generation";
}

function stableGenerationIdentity(tool: ToolName, input: Record<string, unknown>, state: CanvasSnapshot | null) {
    // Canvas routing and optimistic concurrency values describe the page state
    // at submission time, not the generation itself. They change after an
    // accepted task is read back, so including them would make a safe retry
    // with the same operation ID look like a different paid request.
    const {
        clientOperationId: supplied,
        expectedCanvasId: _expectedCanvasId,
        expectedRevision: _expectedRevision,
        expectedStateHash: _expectedStateHash,
        canvasId: _canvasId,
        clientId: _clientId,
        ...request
    } = input;
    const source = tool === "canvas_edit_image" || tool === "canvas_analyze_image" ? state?.nodes?.find((node) => node.id === request.nodeId) : undefined;
    const canonical = stableJson({ tool, projectId: state?.domainProjectId || state?.projectId || "", input: request, ...(source ? { sourceResource: source.metadata?.storageKey || source.metadata?.content } : {}) });
    const fingerprint = crypto.createHash("sha256").update(canonical).digest("hex");
    return {
        clientOperationId: stringValue(supplied) || `canvas:${fingerprint}`,
        clientOperationFingerprint: fingerprint,
    };
}

function withGenerationOperationIds(tool: ToolName, input: Record<string, unknown>, state: CanvasSnapshot | null) {
    const ops = Array.isArray(input.ops) ? input.ops as Array<Record<string, unknown>> : [];
    if (!ops.some((op) => op.type === "run_generation")) return input;
    return {
        ...input,
        ops: ops.map((op, index) => {
            if (op.type !== "run_generation" || stringValue(op.clientOperationId)) return op;
            const canonical = stableJson({ tool, projectId: state?.domainProjectId || state?.projectId || "", index, operation: op });
            const clientOperationId = `canvas:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
            return { ...op, clientOperationId };
        }),
    };
}

function generationOperationIds(input: Record<string, unknown>) {
    const ops = Array.isArray(input.ops) ? input.ops as Array<Record<string, unknown>> : [];
    return [...new Set(ops.filter((op) => op.type === "run_generation").map((op) => stringValue(op.clientOperationId)).filter(Boolean))];
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right));
        return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

function generationMode(value: unknown): "text" | "image" | "video" | "audio" {
    return value === "text" || value === "video" || value === "audio" ? value : "image";
}

function generationTitle(mode: "text" | "image" | "video" | "audio") {
    if (mode === "text") return "文本生成";
    if (mode === "video") return "视频生成";
    if (mode === "audio") return "音频生成";
    return "图片生成";
}

function findNode(state: CanvasSnapshot | null, id: string): CanvasNode | undefined {
    return (state?.nodes || []).find((node) => node.id === id);
}

const DEFAULT_STORYBOARD_COLUMNS = ["shotNumber", "durationSeconds", "videoMotionPrompt", "dialogue", "assets"];

type StoryboardRowData = Record<string, unknown>;
type StoryboardData = { rows: StoryboardRowData[]; visibleColumns: string[]; referenceNodeIds: string[] };

// 只读取画布真实的 StoryboardRow，不另造一套分镜结构。
function storyboardOf(node: CanvasNode | undefined): StoryboardData | undefined {
    const value = node?.metadata?.storyboard;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const data = value as Record<string, unknown>;
    return {
        rows: Array.isArray(data.rows) ? data.rows.filter((row): row is StoryboardRowData => Boolean(row) && typeof row === "object" && !Array.isArray(row)) : [],
        visibleColumns: Array.isArray(data.visibleColumns) ? data.visibleColumns.map(String) : [],
        referenceNodeIds: Array.isArray(data.referenceNodeIds) ? data.referenceNodeIds.map(String) : [],
    };
}

function resolveStoryboardNode(state: CanvasSnapshot | null, nodeId?: string) {
    const nodes = state?.nodes || [];
    if (nodeId) return nodes.find((node) => node.id === nodeId && node.type === "script");
    const scriptNodes = nodes.filter((node) => node.type === "script" && Boolean(storyboardOf(node)));
    if (scriptNodes.length === 1) return scriptNodes[0];
    return scriptNodes.find((node) => (state?.selectedNodeIds || []).includes(node.id));
}

function readStoryboard(state: CanvasSnapshot | null, input: { nodeId?: string }) {
    if (!state) throw new Error("当前没有已连接画布");
    if (input.nodeId && !state.nodes?.some((node) => node.id === input.nodeId && node.type === "script")) throw new Error("分镜只能从真实 Script 节点读取");
    const context = buildCanvasContext(state);
    const nodes = (state.nodes || []).filter((node) => (input.nodeId ? node.id === input.nodeId : node.type === "script" && Boolean(storyboardOf(node))));
    return {
        revision: context.revision,
        stateHash: context.stateHash,
        storyboards: nodes.flatMap((node) => {
            const data = storyboardOf(node);
            if (!data) return [];
            return [{
                nodeId: node.id,
                title: node.title || "",
                visibleColumns: data.visibleColumns.length ? data.visibleColumns : DEFAULT_STORYBOARD_COLUMNS,
                referenceNodeIds: data.referenceNodeIds,
                rows: data.rows.map((row, index) => {
                    const normalized = normalizeStoryboardRow(row, index);
                    return { ...normalized, bindingState: storyboardRowBindingState(state, node, normalized) };
                }),
            }];
        }),
        hint: "多镜头影视任务先 canvas_get_storyboard 读取稳定 rowId 与 revision/stateHash，再用 canvas_update_storyboard 写回；分镜行通过 storyboard-output / storyboard-asset-reference 连线定位节点、任务与资源。",
    };
}

function storyboardRowBindingState(state: CanvasSnapshot, scriptNode: CanvasNode, row: StoryboardRowData) {
    const rowId = stringValue(row.id);
    const connections = (state.connections || []).filter((connection) => connection.storyboardRowId === rowId);
    const outputs = {
        image: storyboardOutputSummary(state, scriptNode, rowId, stringValue(row.imageNodeId), "image"),
        video: storyboardOutputSummary(state, scriptNode, rowId, stringValue(row.videoNodeId), "video"),
    };
    const assets = (Array.isArray(row.assetBindings) ? row.assetBindings : []).map((binding) => {
        const value = isRecord(binding) ? binding : {};
        const nodeId = stringValue(value.nodeId);
        const node = (state.nodes || []).find((candidate) => candidate.id === nodeId);
        const assetConnections = connections.filter((connection) => connection.relation === "storyboard-asset-reference" && connection.fromNodeId === nodeId);
        return {
            nodeId,
            role: stringValue(value.role),
            exists: Boolean(node),
            resourceId: node ? nodeResourceId(node) : undefined,
            resourceReady: Boolean(node && stringValue(node.metadata?.status) === "success" && (nodeResourceId(node) || stringValue(node.metadata?.storageKey) || stringValue(node.metadata?.primaryImageId))),
            nodeStatus: node ? stringValue(node.metadata?.status) || "idle" : "missing",
            outputNodeIds: assetConnections.map((connection) => connection.toNodeId),
            connectionIds: assetConnections.map((connection) => connection.id),
        };
    });
    const segments = (Array.isArray(row.segmentBindings) ? row.segmentBindings : []).map((binding) => {
        const value = isRecord(binding) ? binding : {};
        const summary = storyboardOutputSummary(state, scriptNode, rowId, stringValue(value.videoNodeId), "video");
        const traceIssues = storyboardSegmentTraceIssues(value, summary);
        return {
            ...value,
            nodeExists: summary.exists,
            outputConnected: summary.connected,
            observedTaskId: summary.taskId,
            observedResourceId: summary.resourceId,
            observedTaskStatus: summary.taskStatus,
            traceScope: storyboardSegmentTraceScope(value),
            traceConsistent: traceIssues.length === 0,
            traceIssues,
        };
    });
    const rowTraceIssues = storyboardRowTraceIssues(row, outputs.video, segments);
    return {
        rowTrace: { traceConsistent: rowTraceIssues.length === 0, traceIssues: rowTraceIssues },
        image: outputs.image,
        video: outputs.video,
        assets,
        segments,
        connections: connections.map((connection) => ({
            id: connection.id,
            fromNodeId: connection.fromNodeId,
            toNodeId: connection.toNodeId,
            relation: connection.relation,
            storyboardRowId: connection.storyboardRowId,
        })),
    };
}

function storyboardRowTraceIssues(
    row: StoryboardRowData,
    video: ReturnType<typeof storyboardOutputSummary>,
    segments: Array<Record<string, unknown> & { traceConsistent: boolean }>,
) {
    if (stringValue(row.status) !== "success") return [];
    const issues: string[] = [];
    if (!stringValue(row.videoNodeId)) issues.push("video_node_missing");
    if (!video.exists || !video.typeMatches) issues.push("video_node_unavailable");
    if (!video.connected) issues.push("video_output_disconnected");
    if (video.nodeStatus !== "success") issues.push("video_node_not_succeeded");
    if (!video.resourceReady || !video.resourceId) issues.push("video_resource_not_ready");
    if (segments.length === 0) {
        if (!video.taskId) issues.push("video_task_missing");
        if (video.taskStatus !== "succeeded") issues.push("video_task_not_succeeded");
    } else if (segments.some((segment) => !segment.traceConsistent)) {
        issues.push("segment_trace_inconsistent");
    }
    return issues;
}

function storyboardSegmentTraceIssues(binding: Record<string, unknown>, observed: ReturnType<typeof storyboardOutputSummary>) {
    const status = stringValue(binding.status) || "planned";
    const taskId = stringValue(binding.taskId);
    const resourceId = stringValue(binding.resourceId);
    const stepId = stringValue(binding.stepId);
    const attemptId = stringValue(binding.attemptId);
    const productionScoped = Boolean(stepId && attemptId);
    const issues: string[] = [];
    if (taskId && observed.taskId !== taskId) issues.push("task_id_mismatch");
    if (resourceId && observed.resourceId !== resourceId) issues.push("resource_id_mismatch");

    if (Boolean(stepId) !== Boolean(attemptId)) {
        issues.push("production_attempt_binding_incomplete");
    }
    if (["submitted", "running", "succeeded"].includes(status) && !taskId) issues.push("task_id_missing");
    if (status === "planned" && (observed.nodeStatus === "success" || observed.taskStatus === "succeeded")) {
        issues.push("planned_segment_has_completed_output");
    }
    if (status === "succeeded") {
        if (!stringValue(binding.videoNodeId)) issues.push("video_node_missing");
        if (!observed.exists || !observed.typeMatches) issues.push("video_node_unavailable");
        if (!observed.connected) issues.push("video_output_disconnected");
        if (observed.nodeStatus !== "success") issues.push("video_node_not_succeeded");
        if (observed.taskStatus !== "succeeded") issues.push("generation_task_not_succeeded");
        if (!resourceId) issues.push("resource_id_missing");
        if (!observed.resourceReady || !observed.resourceId) issues.push("resource_not_ready");
        if (!stringValue(binding.model)) issues.push("model_missing");
        if (binding.model && observed.model && stringValue(binding.model) !== observed.model) issues.push("model_mismatch");
        if (productionScoped && !/^.+:\d+$/.test(stringValue(binding.capabilityRevision))) issues.push("capability_revision_missing");
        if (!(Number(binding.requestedDurationSeconds) > 0)) issues.push("segment_duration_missing");
        if (!Number.isInteger(binding.timelineStartMs) || Number(binding.timelineStartMs) < 0) issues.push("timeline_start_missing");
        if (!Number.isInteger(binding.timelineDurationMs) || Number(binding.timelineDurationMs) <= 0) issues.push("timeline_duration_missing");
    }
    return issues;
}

function storyboardSegmentTraceScope(binding: Record<string, unknown>) {
    if ((stringValue(binding.status) || "planned") === "planned") return "planned";
    if (stringValue(binding.stepId) && stringValue(binding.attemptId)) return "production_run";
    return stringValue(binding.taskId) ? "canvas_task" : "unbound";
}

function storyboardOutputSummary(state: CanvasSnapshot, scriptNode: CanvasNode, rowId: string, nodeId: string, expectedType: string) {
    if (!nodeId) return { nodeId: "", exists: false, connected: false, nodeStatus: "unbound" };
    const node = (state.nodes || []).find((candidate) => candidate.id === nodeId);
    const connection = (state.connections || []).find((candidate) => candidate.fromNodeId === scriptNode.id
        && candidate.toNodeId === nodeId
        && candidate.fromHandleId === `row:${rowId}`
        && candidate.storyboardRowId === rowId
        && candidate.relation === "storyboard-output");
    const metadata = node?.metadata || {};
    return {
        nodeId,
        exists: Boolean(node),
        nodeType: node?.type || "missing",
        typeMatches: Boolean(node && node.type === expectedType),
        connected: Boolean(connection),
        connectionId: connection?.id,
        nodeStatus: stringValue(metadata.status) || (node ? "unknown" : "missing"),
        taskId: stringValue(metadata.taskId) || undefined,
        taskStatus: stringValue(metadata.taskStatus) || stringValue(metadata.taskOfficialStatus) || undefined,
        resourceId: node ? nodeResourceId(node) : undefined,
        resourceReady: Boolean(node && stringValue(metadata.status) === "success" && (nodeResourceId(node) || stringValue(metadata.storageKey) || stringValue(metadata.primaryImageId))),
        model: stringValue(metadata.model) || stringValue(metadata.modelName) || undefined,
    };
}

function nodeResourceId(node: CanvasNode) {
    const metadata = node.metadata || {};
    const storageKey = stringValue(metadata.storageKey);
    const storageResourceId = storageKey.startsWith("resource:") ? storageKey.slice("resource:".length) : "";
    return stringValue(metadata.resourceId) || storageResourceId || stringValue(metadata.primaryImageId) || stringValue(metadata.primaryVideoId) || "";
}

type StoryboardConnection = {
    id?: string;
    fromNodeId: string;
    toNodeId: string;
    fromHandleId?: string;
    toHandleId?: string;
    relation: "storyboard-output" | "storyboard-asset-reference";
    storyboardRowId: string;
};

type StoryboardOutputMetadata = { nodeId: string; prompt: string; composerContent: string };

function storyboardRowConnectionOps(state: CanvasSnapshot, scriptNode: CanvasNode, currentRows: StoryboardRowData[], rows: StoryboardRowData[]) {
    const nodes = state.nodes || [];
    const connections = state.connections || [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const desired: StoryboardConnection[] = [];
    const desiredKeys = new Set<string>();
    const rowIds = new Set([...currentRows, ...rows].map((row) => stringValue(row.id)).filter(Boolean));
    const push = (connection: StoryboardConnection) => {
        const key = storyboardConnectionKey(connection);
        if (desiredKeys.has(key)) return;
        desiredKeys.add(key);
        desired.push({ ...connection, id: connection.id || storyboardConnectionId(connection) });
    };

    for (const row of rows) {
        const rowId = stringValue(row.id);
        if (!rowId) throw new Error("每个分镜行都必须有稳定 rowId");
        const targets = new Map<string, string>();
        const addTarget = (value: unknown, expectedType: string, label: string) => {
            const nodeId = stringValue(value);
            if (!nodeId) return;
            const node = nodeById.get(nodeId);
            if (!node || node.type !== expectedType) throw new Error(`分镜 ${rowId} 的 ${label}「${nodeId}」不存在或节点类型不是 ${expectedType}`);
            targets.set(nodeId, expectedType);
        };
        addTarget(row.imageNodeId, "image", "首帧绑定");
        addTarget(row.videoNodeId, "video", "视频绑定");
        const segmentBindings = Array.isArray(row.segmentBindings) ? row.segmentBindings : [];
        for (const binding of segmentBindings) {
            if (!isRecord(binding)) continue;
            addTarget(binding.videoNodeId, "video", `片段 ${stringValue(binding.segmentId) || "?"} 视频绑定`);
        }

        const referenceIds = new Set<string>();
        const rowAssetReferenceIds = new Set<string>();
        const addExplicitReference = (value: unknown, label: string) => {
            const nodeId = stringValue(value);
            if (!nodeId) return;
            if (!nodeById.has(nodeId)) throw new Error(`分镜 ${rowId} 的 ${label}「${nodeId}」不存在`);
            referenceIds.add(nodeId);
        };
        for (const binding of Array.isArray(row.assetBindings) ? row.assetBindings : []) {
            if (isRecord(binding)) {
                addExplicitReference(binding.nodeId, "资产绑定");
                const nodeId = stringValue(binding.nodeId);
                if (nodeId) rowAssetReferenceIds.add(nodeId);
            }
        }
        for (const character of Array.isArray(row.characters) ? row.characters : []) {
            if (!isRecord(character)) continue;
            addExplicitReference(character.characterImageNodeId, "人物图片绑定");
            const characterImageNodeId = stringValue(character.characterImageNodeId);
            if (characterImageNodeId && nodeById.has(characterImageNodeId)) rowAssetReferenceIds.add(characterImageNodeId);
            const assetId = stringValue(character.characterAssetId);
            if (!assetId) continue;
            for (const node of nodes) {
                if (node.metadata?.workflowKind === "character" && stringValue(node.metadata.characterAssetId) === assetId) {
                    referenceIds.add(node.id);
                    rowAssetReferenceIds.add(node.id);
                }
            }
        }
        const generatedOutputIds = new Set([
            stringValue(row.imageNodeId),
            stringValue(row.videoNodeId),
            ...segmentBindings.filter(isRecord).map((binding) => stringValue(binding.videoNodeId)),
        ].filter(Boolean));
        for (const outputId of generatedOutputIds) rowAssetReferenceIds.delete(outputId);
        // An adopted opening image is an input to this storyboard row for video,
        // even when it was originally generated as the row's image output.
        // Keep that input path visible; never add duplicate image-to-video edges.
        const adoptedFirstFrameId = stringValue(row.imageNodeId);
        if (adoptedFirstFrameId) rowAssetReferenceIds.add(adoptedFirstFrameId);
        const storyboard = storyboardOf(scriptNode);
        for (const nodeId of storyboard?.referenceNodeIds || []) if (nodeById.has(nodeId)) referenceIds.add(nodeId);
        if (stringValue(row.imageNodeId)) referenceIds.add(stringValue(row.imageNodeId));
        for (const binding of segmentBindings) {
            if (isRecord(binding)) addExplicitReference(binding.relayReferenceNodeId, `片段 ${stringValue(binding.segmentId) || "?"} 接力参考`);
        }

        for (const [targetId, targetType] of targets) {
            if (targetType === "video") push({
                fromNodeId: scriptNode.id,
                toNodeId: targetId,
                fromHandleId: `row:${rowId}`,
                relation: "storyboard-output",
                storyboardRowId: rowId,
            });
            if (targetType !== "image") continue;
            for (const referenceId of referenceIds) {
                if (referenceId === scriptNode.id || referenceId === targetId) continue;
                if (targetType === "image" && referenceId === stringValue(row.imageNodeId)) continue;
                push({ fromNodeId: referenceId, toNodeId: targetId, relation: "storyboard-asset-reference", storyboardRowId: rowId });
            }
        }
        for (const referenceId of rowAssetReferenceIds) {
            if (referenceId === scriptNode.id) continue;
            push({
                fromNodeId: referenceId,
                toNodeId: scriptNode.id,
                toHandleId: `row:${rowId}`,
                relation: "storyboard-asset-reference",
                storyboardRowId: rowId,
            });
        }
    }

    const existingManaged = connections.filter((connection) => rowIds.has(stringValue(connection.storyboardRowId))
        && (connection.relation === "storyboard-output" || connection.relation === "storyboard-asset-reference"));
    const kept = new Set<string>();
    const staleConnectionIds: string[] = [];
    // A direct image reference and the row-derived reference carry the same
    // input. Replace the untagged duplicate instead of retaining two wires.
    for (const connection of connections) {
        if (connection.relation || connection.fromHandleId || connection.toHandleId) continue;
        if (desired.some((expected) => expected.relation === "storyboard-asset-reference"
            && nodeById.get(expected.toNodeId)?.type === "image"
            && expected.fromNodeId === connection.fromNodeId && expected.toNodeId === connection.toNodeId)) {
            staleConnectionIds.push(connection.id);
        }
    }
    for (const connection of existingManaged) {
        const key = storyboardConnectionKey(connection);
        if (!desiredKeys.has(key) || kept.has(key)) staleConnectionIds.push(connection.id);
        else kept.add(key);
    }
    const ops: Array<Record<string, unknown>> = [];
    if (staleConnectionIds.length) ops.push({ type: "delete_connections", ids: staleConnectionIds });
    for (const connection of desired) {
        if (kept.has(storyboardConnectionKey(connection))) continue;
        ops.push({ type: "connect_nodes", ...connection });
    }
    return { ops, requiredConnections: desired };
}

function storyboardPendingOutputMetadata(
    state: CanvasSnapshot,
    scriptNode: CanvasNode,
    rows: StoryboardRowData[],
    requiredConnections: StoryboardConnection[],
): StoryboardOutputMetadata[] {
    const nodes = state.nodes || [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const output: StoryboardOutputMetadata[] = [];
    for (const row of rows) {
        const rowId = stringValue(row.id);
        for (const target of [
            { nodeId: stringValue(row.imageNodeId), type: "image", prompt: stringValue(row.imageGenerationPrompt) || stringValue(row.plotDescription) },
            { nodeId: stringValue(row.videoNodeId), type: "video", prompt: stringValue(row.videoMotionPrompt) || stringValue(row.plotDescription) },
        ]) {
            if (!target.nodeId || !target.prompt) continue;
            const node = nodeById.get(target.nodeId);
            if (!node || node.type !== target.type || !isPendingStoryboardOutput(node)) continue;
            const referenceIds = new Set(requiredConnections
                .filter((connection) => connection.storyboardRowId === rowId
                    && (connection.toNodeId === target.nodeId || (target.type === "video" && connection.toNodeId === scriptNode.id && connection.toHandleId === `row:${rowId}`))
                    && connection.relation === "storyboard-asset-reference"
                    && connection.fromNodeId !== scriptNode.id)
                .map((connection) => connection.fromNodeId));
            if (target.type === "video") {
                for (const referenceId of storyboardOf(scriptNode)?.referenceNodeIds || []) if (nodeById.has(referenceId)) referenceIds.add(referenceId);
                const firstFrameId = stringValue(row.imageNodeId);
                if (firstFrameId && nodeById.has(firstFrameId)) referenceIds.add(firstFrameId);
                for (const binding of Array.isArray(row.segmentBindings) ? row.segmentBindings : []) {
                    if (isRecord(binding) && nodeById.has(stringValue(binding.relayReferenceNodeId))) referenceIds.add(stringValue(binding.relayReferenceNodeId));
                }
            }
            for (const connection of state.connections || []) {
                if (connection.toNodeId !== target.nodeId || connection.relation || connection.fromNodeId === scriptNode.id) continue;
                if (nodeById.has(connection.fromNodeId)) referenceIds.add(connection.fromNodeId);
            }
            const inlineIds = new Set(Array.from(target.prompt.matchAll(/@\[node:([^\]]+)\]/g), (match) => match[1]));
            const mentionTokens = [...referenceIds]
                .filter((referenceId) => referenceId !== target.nodeId && !inlineIds.has(referenceId))
                .map((referenceId) => `@[node:${referenceId}]`);
            output.push({
                nodeId: target.nodeId,
                prompt: target.prompt,
                composerContent: [...mentionTokens, target.prompt].filter(Boolean).join("\n"),
            });
        }
    }
    return output;
}

function isPendingStoryboardOutput(node: CanvasNode) {
    const metadata = node.metadata || {};
    const status = stringValue(metadata.status);
    const taskStatus = stringValue(metadata.taskStatus);
    if (stringValue(metadata.taskId) || stringValue(metadata.content) || stringValue(metadata.resourceId)
        || stringValue(metadata.primaryImageId) || stringValue(metadata.primaryVideoId) || stringValue(metadata.storageKey)) return false;
    if (["loading", "submitted", "running", "success", "succeeded"].includes(status)
        || ["loading", "submitted", "running", "success", "succeeded"].includes(taskStatus)) return false;
    return !status || status === "idle" || status === "error";
}

function storyboardConnectionKey(connection: { storyboardRowId?: string; relation?: string; fromNodeId: string; toNodeId: string; fromHandleId?: string; toHandleId?: string }) {
    return [connection.storyboardRowId, connection.relation, connection.fromNodeId, connection.toNodeId, connection.fromHandleId || "", connection.toHandleId || ""].join("\0");
}

function storyboardConnectionId(connection: StoryboardConnection) {
    return `storyboard-${crypto.createHash("sha256").update(storyboardConnectionKey(connection)).digest("hex").slice(0, 24)}`;
}

function sameStoryboardConnection(connection: NonNullable<CanvasSnapshot["connections"]>[number], expected: StoryboardConnection) {
    return connection.storyboardRowId === expected.storyboardRowId
        && connection.relation === expected.relation
        && connection.fromNodeId === expected.fromNodeId
        && connection.toNodeId === expected.toNodeId
        && (connection.fromHandleId || "") === (expected.fromHandleId || "")
        && (connection.toHandleId || "") === (expected.toHandleId || "");
}

/**
 * 删除 Script 节点时，节点删除只带走与它相连的边；行级资产参考边连接的是别的节点，
 * 必须在同一批操作里按 storyboardRowId 显式清理，避免留下指向已删除行的孤儿连线。
 */
function orphanedStoryboardConnectionIds(state: CanvasSnapshot | null, nodeIds: string[]) {
    if (!state) return [] as string[];
    const removed = new Set((nodeIds || []).filter(Boolean));
    if (!removed.size) return [] as string[];
    const rowIds = new Set<string>();
    for (const node of state.nodes || []) {
        if (!removed.has(node.id)) continue;
        for (const row of storyboardOf(node)?.rows || []) {
            const rowId = stringValue(row.id);
            if (rowId) rowIds.add(rowId);
        }
    }
    if (!rowIds.size) return [] as string[];
    return (state.connections || []).flatMap((connection) => {
        const rowId = stringValue((connection as Record<string, unknown>).storyboardRowId);
        if (!rowId || !rowIds.has(rowId)) return [];
        // 两端都还在的连线不会被 delete_node 带走，需要显式删除。
        if (removed.has(connection.fromNodeId) || removed.has(connection.toNodeId)) return [];
        return connection.id ? [connection.id] : [];
    });
}

function normalizeStoryboardRow(row: StoryboardRowData, index: number): StoryboardRowData {
    const text = (value: unknown) => typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
    const list = (value: unknown) => Array.isArray(value) ? value.map((item) => String(item)) : [];
    const number = (value: unknown, fallback: number) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; };
    const shotNumber = Math.max(1, Math.round(number(row.shotNumber, index + 1)));
    // 叙事镜头时长独立于单次模型请求；生成前由能力合同拆分片段。
    const durationSeconds = Math.max(0, number(row.durationSeconds, 6));
    const result: StoryboardRowData = {
        id: typeof row.id === "string" && row.id.trim() ? row.id.trim() : `shot-${shotNumber}`,
        sceneId: text(row.sceneId),
        shotNumber,
        durationSeconds,
        plotDescription: text(row.plotDescription),
        dialogue: text(row.dialogue),
        voiceover: text(row.voiceover),
        characters: Array.isArray(row.characters) ? row.characters : [],
        narrativeIntent: text(row.narrativeIntent),
        viewerPOV: text(row.viewerPOV),
        performanceBlocking: text(row.performanceBlocking),
        shotSize: text(row.shotSize),
        emotion: text(row.emotion),
        lightingAndAtmosphere: text(row.lightingAndAtmosphere),
        audioEffects: text(row.audioEffects),
        camera: text(row.camera),
        motion: text(row.motion),
        timeBeats: text(row.timeBeats),
        imageGenerationPrompt: text(row.imageGenerationPrompt),
        videoMotionPrompt: text(row.videoMotionPrompt),
        mustHave: list(row.mustHave),
        optionalDetails: list(row.optionalDetails),
        continuityOut: text(row.continuityOut),
        negativePrompt: text(row.negativePrompt),
        assetBindings: Array.isArray(row.assetBindings) ? row.assetBindings : [],
        requiredAssetRoles: Array.isArray(row.requiredAssetRoles)
            ? [...new Set(row.requiredAssetRoles.filter((role): role is string => typeof role === "string" && ["character", "environment", "wardrobe", "prop", "weapon", "style", "motion", "audio"].includes(role)))]
            : [],
        segmentBindings: normalizeStoryboardSegments(row.segmentBindings),
        status: row.status === "ready" || row.status === "success" || row.status === "loading" || row.status === "error" ? row.status : "idle",
    };
    if (["text_to_video", "image_to_video", "reference_to_video", "audio_to_video", "extend"].includes(String(row.videoOperation))) {
        result.videoOperation = row.videoOperation;
    }
    for (const key of ["imageNodeId", "videoNodeId", "errorDetails"] as const) {
        const value = row[key];
        if (typeof value === "string" && value.trim()) result[key] = value.trim();
    }
    for (const key of ["imagePromptTemplateVariables", "videoPromptTemplateVariables"] as const) {
        const value = row[key];
        if (isRecord(value)) result[key] = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    }
    return result;
}

function normalizeStoryboardSegments(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        if (!isRecord(item)) return [];
        const segmentId = stringValue(item.segmentId);
        const order = Number(item.order);
        if (!segmentId || !Number.isInteger(order) || order < 0) return [];
        const result: Record<string, unknown> = { segmentId, order };
        for (const key of ["videoNodeId", "taskId", "resourceId", "stepId", "attemptId", "relayReferenceNodeId", "inputFingerprint", "model", "capabilityRevision"] as const) {
            const field = item[key];
            if (typeof field === "string" && field.trim()) result[key] = field.trim();
        }
        for (const key of ["requestedDurationSeconds", "timelineStartMs", "timelineDurationMs"] as const) {
            const field = Number(item[key]);
            if (item[key] !== null && item[key] !== undefined && Number.isFinite(field) && field >= 0) result[key] = field;
        }
        const statuses = new Set(["planned", "submitted", "running", "succeeded", "failed", "uncertain", "cancelled"]);
        result.status = typeof item.status === "string" && statuses.has(item.status) ? item.status : "planned";
        return [result];
    }).sort((left, right) => Number(left.order) - Number(right.order));
}

function mergeStoryboardRows(current: StoryboardRowData[], incoming: StoryboardRowData[], mode: "replace" | "merge" | "append") {
    let rows: StoryboardRowData[];
    if (mode === "replace") {
        rows = incoming.map((row, index) => {
            const position = findStoryboardRowMatch(current, row);
            return normalizeStoryboardRow(position >= 0 ? { ...current[position], ...row } : row, index);
        });
    } else {
        rows = current.map((row) => ({ ...row }));
        if (mode === "append") {
            incoming.forEach((row, index) => rows.push(normalizeStoryboardRow({ ...row, shotNumber: row.shotNumber ?? rows.length + 1 }, rows.length + index)));
        } else {
            incoming.forEach((row, index) => {
                const position = findStoryboardRowMatch(rows, row);
                if (position >= 0) rows[position] = normalizeStoryboardRow({ ...rows[position], ...row }, position);
                else rows.push(normalizeStoryboardRow(row, rows.length + index));
            });
        }
    }
    const ids = new Set<string>();
    for (const row of rows) {
        const id = stringValue(row.id);
        if (!id || ids.has(id)) throw new Error(`分镜行 rowId 缺失或重复：${id || "(empty)"}`);
        ids.add(id);
    }
    return rows;
}

function findStoryboardRowMatch(rows: StoryboardRowData[], incoming: StoryboardRowData) {
    const id = stringValue(incoming.id);
    if (id) {
        const exact = rows.findIndex((row) => stringValue(row.id) === id);
        if (exact >= 0) return exact;
        // First write of a legacy row materializes its deterministic shot-N rowId.
        const legacy = rows.findIndex((row, index) => !stringValue(row.id) && normalizeStoryboardRow(row, index).id === id);
        return legacy;
    }
    const shotNumber = Number(incoming.shotNumber);
    if (!Number.isFinite(shotNumber)) return -1;
    // shotNumber is only a bridge for old rows that have no stable id on either side.
    return rows.findIndex((row) => !stringValue(row.id) && Number(row.shotNumber) === shotNumber);
}

function cleanRecord(value: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : "";
}

function validateReferenceOperationInput(input: Record<string, unknown>) {
    const requiredByOperation: Record<string, string[]> = {
        add: ["sourceNodeId"],
        remove: ["sourceNodeId"],
        replace: ["sourceNodeId", "oldSourceNodeId"],
        reorder: ["sourceNodeIds"],
    };
    const operation = stringValue(input.operation);
    const required = requiredByOperation[operation];
    if (!required) throw new Error("引用操作类型无效");
    for (const key of required) {
        if (key === "sourceNodeIds") {
            const ids = input.sourceNodeIds;
            if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !stringValue(id))) throw new Error("重排引用必须提供非空 sourceNodeIds");
        } else if (!stringValue(input[key])) {
            throw new Error(`${operation} 引用操作缺少 ${key}`);
        }
    }
    const operationFields = ["sourceNodeId", "oldSourceNodeId", "sourceNodeIds"];
    const allowed = new Set(required);
    for (const key of operationFields) {
        if (!allowed.has(key) && input[key] !== undefined) throw new Error(`${operation} 引用操作不接受 ${key}`);
    }
}

function isMutatingTool(name: string) {
    if (name.startsWith("canvas_")) return !isCanvasReadOnlyTool(name);
    if (name.startsWith("project_")) return !["project_get_context", "project_list_units", "project_list_voices"].includes(name);
    if (name.startsWith("film_")) return ![
        "film_list_operations", "film_list_models", "film_validate_strategy", "film_get_run", "film_get_tasks", "film_wait_task", "film_probe_media", "film_check_shot", "film_self_check",
    ].includes(name);
    return false;
}

function isCanvasReadOnlyTool(name: string) {
    return new Set([
        "canvas_read_quality_reports",
        "canvas_preflight_image_edit",
        "canvas_get_state", "canvas_get_drawing", "canvas_get_context", "canvas_get_capabilities", "canvas_list_open_canvases", "canvas_find_nodes", "canvas_find_available_assets", "canvas_preflight_storyboard_media", "canvas_preflight_batch_rows", "canvas_get_node",
        "canvas_get_connection", "canvas_get_generation_tasks", "canvas_get_resources", "canvas_validate_ops",
        "canvas_get_selection", "canvas_export_snapshot", "canvas_get_storyboard", "canvas_get_timeline", "canvas_list_director_scenes", "canvas_get_director_scene", "canvas_list_projects", "canvas_export_projects", "canvas_batch_table_read", "canvas_inspect_node_render",
    ]).has(name);
}

function snapshotFromToolResult(value: unknown): CanvasSnapshot | null {
    if (!isRecord(value)) return null;
    const direct = isRecord(value.snapshot) ? value.snapshot : null;
    const data = isRecord(value.data) ? value.data : null;
    const nested = data && isRecord(data.snapshot) ? data.snapshot : null;
    const snapshot = direct || nested;
    if (!snapshot || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.connections)) return null;
    return snapshot as unknown as CanvasSnapshot;
}
