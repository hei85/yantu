import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http, { type Server } from "node:http";
import { test } from "node:test";

import { buildCanvasContext } from "../src/canvas-context.js";
import { CanvasSession } from "../src/canvas-session.js";
import { createLocalRuntimeApp } from "../src/local-runtime.js";
import { LocalRuntimeSessionManager } from "../src/local-runtime-session.js";
import { createCanvasAgentHttpModule } from "../src/modules/canvas-agent-http.js";
import { toolDescriptions, toolInputSchemas, toolNames } from "../src/schemas.js";
import type { CanvasSnapshot } from "../src/types.js";
import type { LocalRuntimeConfig } from "../src/config.js";

const authority = "127.0.0.1:41743";
const endpoint = `http://${authority}`;
const origin = "http://127.0.0.1:3001";
const token = "legacy-canvas-token-fixture";

const canvasReadSelectors = new Set([
    "runtime_diagnostics", "canvas_get_state", "canvas_get_context", "canvas_find_nodes", "canvas_find_available_assets",
    "canvas_preflight_storyboard_media", "canvas_preflight_batch_rows", "canvas_get_node", "canvas_get_connection", "canvas_get_generation_tasks",
    "canvas_get_resources", "canvas_validate_ops", "canvas_get_selection", "canvas_export_snapshot", "canvas_get_storyboard",
    "canvas_get_timeline", "canvas_list_projects", "canvas_export_projects", "canvas_batch_table_read",
]);

class FixtureCanvasSession extends CanvasSession {
    private fixtureStates = new Map<string, CanvasSnapshot>();
    private rawStateHashes = new Map<string, string>();
    private activeResponses = new Map<string, Parameters<CanvasSession["openEvents"]>[1]>();

    openEvents(url: URL, res: Parameters<CanvasSession["openEvents"]>[1], runtimeSessionId?: string) {
        const clientId = url.searchParams.get("clientId");
        if (clientId) {
            this.activeResponses.set(clientId, res);
            res.on("close", () => {
                if (this.activeResponses.get(clientId) !== res) return;
                this.activeResponses.delete(clientId);
                this.fixtureStates.delete(clientId);
                this.rawStateHashes.delete(clientId);
            });
        }
        return super.openEvents(url, res, runtimeSessionId);
    }

    updateState(body: unknown, clientId?: string) {
        const rawSnapshot = body && typeof body === "object" && !Array.isArray(body) ? body as CanvasSnapshot : undefined;
        const rawHash = rawSnapshot ? buildCanvasContext(rawSnapshot).stateHash : undefined;
        if (clientId && body && typeof body === "object" && !Array.isArray(body) && !("projectId" in body)) {
            body = { ...body, projectId: `fixture-canvas-${clientId}` };
        }
        const result = super.updateState(body, clientId);
        if (result.accepted && clientId && body && typeof body === "object" && !Array.isArray(body)) {
            this.fixtureStates.set(clientId, { ...(body as CanvasSnapshot), clientId, revision: result.revision });
            if (rawHash) this.rawStateHashes.set(clientId, rawHash);
        }
        return result;
    }

    resolveResult(body: Parameters<CanvasSession["resolveResult"]>[0], clientId?: string) {
        const liveIds = [...this.fixtureStates.keys()].filter((id) => this.activeResponses.has(id));
        const resolvedClientId = clientId || (liveIds.length === 1 ? liveIds[0] : "");
        if (resolvedClientId && body.result && typeof body.result === "object" && !Array.isArray(body.result)) {
            const current = this.fixtureStates.get(resolvedClientId);
            const result = body.result as Record<string, unknown>;
            const snapshot = result.snapshot && typeof result.snapshot === "object" && !Array.isArray(result.snapshot)
                ? result.snapshot as Record<string, unknown>
                : undefined;
            if (current && snapshot && !snapshot.projectId) {
                body = { ...body, result: { ...result, snapshot: { ...snapshot, projectId: current.projectId } } };
            } else if (current && Array.isArray(result.nodes) && Array.isArray(result.connections) && !result.projectId) {
                body = { ...body, result: { ...result, projectId: current.projectId } };
            }
        }
        return super.resolveResult(body, resolvedClientId);
    }

    callTool(name: unknown, rawInput: unknown) {
        if (typeof name !== "string" || !rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
            return super.callTool(name, rawInput);
        }
        const input = { ...(rawInput as Record<string, unknown>) };
        const liveStates = [...this.fixtureStates.entries()].filter(([id]) => this.activeResponses.has(id));
        const soleCanvas = liveStates.length === 1 ? { ...liveStates[0][1], canvasId: liveStates[0][1].projectId, clientId: liveStates[0][0] } : undefined;
        const isCanvasMutation = name.startsWith("canvas_") && !canvasReadSelectors.has(name) && !["canvas_get_capabilities", "canvas_list_open_canvases"].includes(name);
        if (isCanvasMutation && soleCanvas) {
            const hasAnyPrecondition = ["expectedCanvasId", "expectedRevision", "expectedStateHash"].some((key) => key in input);
            if (!hasAnyPrecondition) {
                const context = buildCanvasContext(soleCanvas);
                input.expectedCanvasId = soleCanvas.canvasId;
                input.expectedRevision = context.revision;
                input.expectedStateHash = context.stateHash;
            } else if (!input.expectedCanvasId) {
                input.expectedCanvasId = soleCanvas.canvasId;
            }
            if (input.expectedRevision === soleCanvas.revision && input.expectedStateHash === this.rawStateHashes.get(soleCanvas.clientId)) {
                input.expectedStateHash = buildCanvasContext(soleCanvas).stateHash;
            }
        } else if (soleCanvas && (canvasReadSelectors.has(name) || name.startsWith("skill_") || name.startsWith("project_") || name.startsWith("film_"))) {
            input.canvasId ??= soleCanvas.canvasId;
            input.clientId ??= soleCanvas.clientId;
        }
        return super.callTool(name, input);
    }
}

test("MCP manifest exposes the semantic canvas read tools with schemas and descriptions", () => {
    const expected = [
        "canvas_get_context",
        "canvas_find_nodes",
        "canvas_preflight_batch_rows",
        "canvas_generate_batch_rows",
        "canvas_edit_reference",
        "canvas_get_node",
        "canvas_get_connection",
        "canvas_get_generation_tasks",
        "canvas_get_resources",
        "canvas_validate_ops",
    ];
    for (const name of expected) {
        assert.ok(toolNames.includes(name as typeof toolNames[number]), `${name} is missing from toolNames`);
        assert.ok(toolDescriptions[name as keyof typeof toolDescriptions], `${name} is missing a description`);
        assert.ok(toolInputSchemas[name as keyof typeof toolInputSchemas], `${name} is missing an input schema`);
    }
    assert.match(toolDescriptions.canvas_get_storyboard, /traceConsistent=false/);
    assert.deepEqual(
        toolNames.filter((name) => name.startsWith("canvas_")).slice(0, 13),
        [
            "canvas_get_state",
            "canvas_get_drawing",
            "canvas_update_drawing",
            "canvas_update_tldraw_drawing",
            "canvas_get_capabilities",
            "canvas_list_open_canvases",
            "canvas_layout_nodes",
            "canvas_undo_agent_ops",
            "canvas_redo_agent_ops",
            "canvas_duplicate_node",
            "canvas_toggle_node_locked",
            "canvas_toggle_frame_collapsed",
            "canvas_insert_asset",
        ],
    );
});

test("film_submit_step accepts a locked revision or derives it from the saved plan and live catalog", () => {
    const input = {
        runId: "run-1",
        expectedRevision: 1,
        stepId: "step-1",
        idempotencyKey: "attempt-1",
        task: { type: "canvas_video", prompt: "fixture" },
    };
    assert.equal(toolInputSchemas.film_submit_step.safeParse(input).success, true);
    assert.equal(toolInputSchemas.film_submit_step.safeParse({ ...input, capabilityRevision: "model-1:7" }).success, true);
    assert.match(toolDescriptions.film_submit_step, /持久授权明确为 unbounded/);
    assert.match(toolDescriptions.film_submit_step, /0 不代表免费/);
    assert.match(toolDescriptions.film_submit_step, /有界预算必须提供真实核验的正数预估/);
});

test("MCP manifest exposes persistent production quality evidence writeback", () => {
    assert.ok(toolNames.includes("film_record_step_result"));
    assert.match(toolDescriptions.film_record_step_result, /语义质量.*uncertain/);
    assert.match(toolDescriptions.film_record_step_result, /连续性技能.*版本\/哈希.*实际应用结果/);
    assert.equal(toolInputSchemas.film_record_step_result.safeParse({
        runId: "run-1",
        expectedRevision: 2,
        stepId: "check-1",
        evidence: { checks: [{ id: "continuity", status: "uncertain" }] },
    }).success, true);
});

test("canvas generation accepts a stable client operation id for timeout-safe retries", () => {
    const input = { prompt: "fixture clip", clientOperationId: "canvas-test-operation-0001", expectedCanvasId: "canvas-test", expectedRevision: 0, expectedStateHash: "state-hash" };
    assert.equal(toolInputSchemas.canvas_generate_video.safeParse(input).success, true);
    assert.equal(toolInputSchemas.canvas_generate_video.safeParse({ ...input, clientOperationId: "short" }).success, false);
    assert.equal(toolInputSchemas.canvas_generate_video.safeParse({
        ...input,
        videoOperation: "image_to_video",
        videoRatio: "16:9",
        videoResolution: "1088P",
        videoSeconds: 5,
        videoStartFrameNodeId: "frame-1",
    }).success, true);
    assert.equal(toolInputSchemas.canvas_run_generation.safeParse({
        nodeId: "video-1", clientOperationId: input.clientOperationId,
        expectedCanvasId: input.expectedCanvasId, expectedRevision: input.expectedRevision, expectedStateHash: input.expectedStateHash,
    }).success, true);
    assert.match(toolDescriptions.canvas_generate_video, /clientOperationId/);
    assert.match(toolDescriptions.canvas_generate_video, /videoStartFrameNodeId/);
});

test("Canvas module declares only Canvas scopes and constructs without CLI side effects", () => {
    const calls: string[] = [];
    const module = createCanvasAgentHttpModule(fixtureConfig(), sessionFixture(calls));

    assert.deepEqual(module.descriptor, {
        id: "canvas-agent",
        displayName: "Canvas Agent",
        apiVersion: 1,
        scopes: ["canvas:connect"],
    });
    assert.ok(module.routes.some((route) => route.path === "/events" && route.lastEventId));
    assert.ok(module.routes.every((route) => route.scope === "canvas:connect" && route.legacy));
    assert.deepEqual(calls, []);
});

test("Canvas legacy guard strips token before core handlers and rejects the wrong token", async () => {
    const calls: Array<{ name: string; value?: unknown }> = [];
    const session = sessionFixture(calls);
    const module = createCanvasAgentHttpModule(fixtureConfig(), session);
    const manager = new LocalRuntimeSessionManager({
        endpoint,
        trustedOrigins: [origin],
        registrations: [],
    });
    const app = createLocalRuntimeApp({
        authority,
        endpoint,
        version: "0.1.0",
        sessionManager: manager,
        modules: [module],
        legacyMasterToken: token,
        legacyOrigins: [origin],
    });
    const server = app.listen(0, "127.0.0.1");
    await listening(server);
    try {
        const accepted = await request(server, {
            method: "POST",
            path: `/canvas/state?clientId=fixture&token=${token}`,
            headers: jsonHeaders(),
            body: '{"nodes":[]}',
        });
        assert.equal(accepted.status, 200);
        assert.deepEqual(calls.at(-1), { name: "state", value: { nodes: [] } });

        const event = await request(server, {
            path: `/events?clientId=fixture&token=${token}`,
            headers: { Host: authority, Origin: origin },
        });
        assert.equal(event.status, 204);
        assert.deepEqual(calls.at(-1), {
            name: "events",
            value: { clientId: "fixture", token: null },
        });

        const before = calls.length;
        const rejected = await request(server, {
            method: "POST",
            path: "/canvas/state?token=wrong",
            headers: jsonHeaders(),
            body: '{"nodes":[]}',
        });
        assert.equal(rejected.status, 401);
        assert.equal(calls.length, before);

        const missingResultClient = await request(server, {
            method: "POST",
            path: `/canvas/result?token=${token}`,
            headers: jsonHeaders(),
            body: JSON.stringify({ requestId: "request-1", result: { ok: true } }),
        });
        assert.equal(missingResultClient.status, 400);
    } finally {
        manager.dispose();
        await close(server);
    }
});

test("CanvasSession dispose closes streams and a replaced stream cannot clear the active client", () => {
    const session = new FixtureCanvasSession();
    const first = eventResponse();
    const second = eventResponse();

    session.openEvents(new URL("http://127.0.0.1/events?clientId=fixture"), first.response as never);
    session.updateState({ nodes: [] }, "fixture");
    session.openEvents(new URL("http://127.0.0.1/events?clientId=fixture"), second.response as never);
    first.response.emit("close");
    assert.deepEqual(session.health(), { ok: true, hasCanvas: true, clients: 1 });

    session.dispose();
    assert.equal(second.ended(), 1);
    assert.deepEqual(session.health(), { ok: true, hasCanvas: false, clients: 0 });
    second.response.emit("close");
});

test("CanvasSession exposes precise node and connection reads", async () => {
    const session = new FixtureCanvasSession();
    const response = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=precise-read"), response.response as never);
    session.updateState({
        nodes: [
            { id: "node-a", type: "text", title: "A", position: { x: 0, y: 0 }, width: 320, height: 240 },
            { id: "node-b", type: "image", title: "B", position: { x: 400, y: 0 }, width: 320, height: 320, metadata: { status: "success", storageKey: "resource:b" } },
        ],
        connections: [{ id: "connection-1", fromNodeId: "node-a", toNodeId: "node-b" }],
    }, "precise-read");
    assert.equal((await session.callTool("canvas_get_node", { id: "node-b" }) as { found: boolean }).found, true);
    assert.equal((await session.callTool("canvas_get_connection", { id: "connection-1" }) as { found: boolean }).found, true);
    assert.equal((await session.callTool("canvas_get_node", { id: "missing" }) as { found: boolean }).found, false);
    session.dispose();
});

test("CanvasSession closes only streams owned by a revoked Runtime session", async () => {
    const session = new FixtureCanvasSession();
    const closeRuntimeSession = (session as CanvasSession & {
        closeRuntimeSession?: (sessionId: string) => void;
    }).closeRuntimeSession;
    assert.equal(typeof closeRuntimeSession, "function");
    if (!closeRuntimeSession) return;

    const first = eventResponse();
    const second = eventResponse();
    const legacy = eventResponse();
    const openEvents = session.openEvents as unknown as (
        url: URL,
        response: EventEmitter,
        runtimeSessionId?: string,
    ) => void;
    openEvents.call(session, new URL("http://127.0.0.1/events?clientId=first"), first.response, "session-a");
    openEvents.call(session, new URL("http://127.0.0.1/events?clientId=second"), second.response, "session-b");
    openEvents.call(session, new URL("http://127.0.0.1/events?clientId=legacy"), legacy.response);
    session.updateState({ nodes: [] }, "first");
    const pending = session.callTool("canvas_apply_ops", { ops: [] });

    closeRuntimeSession.call(session, "session-a");

    assert.equal(first.ended(), 1);
    assert.equal(second.ended(), 0);
    assert.equal(legacy.ended(), 0);
    assert.deepEqual(session.health(), { ok: true, hasCanvas: false, clients: 2 });
    await assert.rejects(pending, /会话已撤销/);
    session.dispose();
});

test("Canvas short generation submission rejects a disconnected page without resubmitting", async () => {
    const session = new FixtureCanvasSession();
    const first = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=agent-client-before-refresh"), first.response as never);
    session.updateState({
        nodes: [{ id: "existing-image", type: "image", title: "Existing", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { generationMode: "image", taskId: "dreamina:prior-task-0001" } }],
    }, "agent-client-before-refresh");

    try {
        const pending = session.callTool("canvas_run_generation", { nodeId: "existing-image", mode: "image", prompt: "Retry image", retry: true });
        latestToolCall(first.writes());
        first.response.emit("close");
        await assert.rejects(pending, /画布连接已断开/);
        assert.equal(first.writes().filter((value) => value.includes("event: tool_call")).length, 1, "disconnect must not dispatch a second paid request");
    } finally {
        session.dispose();
    }
});
test("CanvasSession expands a workflow into semantic nodes, non-overlapping layout, real edges, and selective generation", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=agent-workflow"), events.response as never);
    session.updateState({
        nodes: [{ id: "existing-character", type: "image", title: "角色原画", position: { x: 0, y: 0 }, width: 560, height: 380, metadata: { status: "success", storageKey: "resource:character" } }],
        connections: [],
    }, "agent-workflow");

    try {
        const pending = session.callTool("canvas_create_workflow", {
            title: "搞笑修仙小说流水线",
            nodes: [
                { ref: "cards", kind: "character_cards", title: "角色拆分图片卡片", referenceNodeIds: ["existing-character"] },
                { ref: "views", kind: "character_three_view", title: "角色三视图", prompt: "基于角色卡片生成正面、侧面、背面三视图", referenceRefs: ["cards"] },
                { ref: "storyboard", kind: "storyboard_video", title: "分镜剧情视频", prompt: "基于三视图制作分镜剧情视频", referenceRefs: ["views"], runGeneration: true },
            ],
        });
        const call = latestToolCall(events.writes());
        const ops = (call.input as { ops: Array<Record<string, unknown>> }).ops;
        const added = ops.filter((op) => op.type === "add_node");
        const edges = ops.filter((op) => op.type === "connect_nodes");
        const runs = ops.filter((op) => op.type === "run_generation");

        assert.deepEqual(added.map((op) => op.nodeType), ["image", "image", "video"]);
        assert.match(String((added[0]?.metadata as Record<string, unknown>)?.prompt), /拆分主要角色/);
        assert.equal(edges.length, 3, "two workflow edges plus one existing reference edge");
        assert.equal(runs.length, 1, "runGeneration only affects the explicitly requested node");
        assert.equal(runs[0]?.nodeId, added[2]?.id);
        assert.ok(Number((added[1]?.position as { x: number }).x) > Number((added[0]?.position as { x: number }).x) + Number(added[0]?.width));
        assert.ok(Number((added[2]?.position as { x: number }).x) > Number((added[1]?.position as { x: number }).x) + Number(added[1]?.width));
        assert.ok(edges.some((op) => op.fromNodeId === "existing-character" && op.toNodeId === added[0]?.id));

        session.resolveResult({ requestId: call.requestId, result: { accepted: true } });
        assert.deepEqual(await pending, { accepted: true });
    } finally {
        session.dispose();
    }
});

test("CanvasSession rejects media workflow nodes without real creative content", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=agent-workflow-invalid"), events.response as never);
    session.updateState({ nodes: [] }, "agent-workflow-invalid");
    try {
        await assert.rejects(
            session.callTool("canvas_create_workflow", {
                nodes: [{ ref: "empty-image", kind: "image", title: "空图片节点" }],
            }),
            /缺少 prompt\/content/,
        );
        assert.equal(events.writes().some((value) => value.includes("event: tool_call")), false);
    } finally {
        session.dispose();
    }
});

test("Canvas Dreamina image generation preserves the shared product model and auto quality before run_generation", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=agent-dreamina-product"), events.response as never);
    session.updateState({ nodes: [] }, "agent-dreamina-product");

    try {
        const generated = session.callTool("canvas_generate_image", {
            prompt: "A cinematic city at night",
            model: "local:dreamina-cli:5.0",
            quality: "auto",
            size: "16:9",
            count: 1,
        });
        const call = latestToolCall(events.writes());
        const ops = (call.input as { ops: Array<Record<string, unknown>> }).ops;
        const target = ops.find((op) => op.type === "add_node" && op.nodeType === "image");
        const metadata = target?.metadata as Record<string, unknown> | undefined;
        const run = ops.find((op) => op.type === "run_generation");
        assert.equal(metadata?.model, "local:dreamina-cli:5.0");
        assert.equal(metadata?.quality, "auto");
        assert.equal(metadata?.size, "16:9");
        assert.deepEqual(run && { type: run.type, nodeId: run.nodeId, mode: run.mode }, {
            type: "run_generation",
            nodeId: target?.id,
            mode: "image",
        });
        session.resolveResult({ requestId: call.requestId, result: { accepted: true } });
        await generated;
    } finally {
        session.dispose();
    }
});

test("CanvasSession keeps every canvas tool timeout at 30s with one settlement", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const delays: number[] = [];
    const cleared = new Set<unknown>();
    let nextHandle = 0;
    Object.defineProperty(globalThis, "setTimeout", {
        configurable: true,
        value: ((_: (...args: unknown[]) => void, delay?: number) => {
            delays.push(Number(delay));
            return { id: ++nextHandle, unref() {} };
        }) as typeof setTimeout,
    });
    Object.defineProperty(globalThis, "clearTimeout", {
        configurable: true,
        value: ((handle: unknown) => { cleared.add(handle); }) as typeof clearTimeout,
    });
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=timeout-client"), events.response as never);
    session.updateState({ nodes: [] }, "timeout-client");
    try {
        const ordinary = session.callTool("canvas_apply_ops", { ops: [{ type: "select_nodes", ids: [] }] });
        const ordinaryCall = latestToolCall(events.writes());
        assert.equal(delays.at(-1), 30_000);
        session.resolveResult({ requestId: ordinaryCall.requestId, result: { accepted: "ordinary" } });
        assert.deepEqual(await ordinary, { accepted: "ordinary" });

        const generation = session.callTool("canvas_generate_image", {
            prompt: "A safe fixture",
            model: "local:dreamina-cli:5.0",
            quality: "auto",
            size: "16:9",
            count: 1,
        });
        const generationCall = latestToolCall(events.writes());
        assert.equal(delays.at(-1), 30_000);
        let settlements = 0;
        void generation.then(() => { settlements += 1; }, () => { settlements += 1; });
        session.resolveResult({ requestId: generationCall.requestId, result: { accepted: "generation" } });
        assert.deepEqual(await generation, { accepted: "generation" });
        await Promise.resolve();
        assert.equal(settlements, 1);
        session.resolveResult({ requestId: generationCall.requestId, result: { accepted: "duplicate" } });
        await Promise.resolve();
        assert.equal(settlements, 1);
        assert.equal(cleared.size, 2);
    } finally {
        Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: originalSetTimeout });
        Object.defineProperty(globalThis, "clearTimeout", { configurable: true, value: originalClearTimeout });
        session.dispose();
    }
});

test("CanvasSession reuses generation id and generated node ids for an exact retry", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    const clientId = "generation-idempotency-client";
    session.openEvents(new URL(`http://127.0.0.1/events?clientId=${clientId}`), events.response as never);
    session.updateState({ projectId: "generation-idempotency-canvas", nodes: [] }, clientId);
    const input = { prompt: "A tiny fixture clip", model: "CHANNEL_000002::minimax_h3_b99_001", seconds: "5", size: "16:9", vquality: "736P", clientOperationId: "generation-retry-operation-001" };
    try {
        const first = session.callTool("canvas_generate_video", input);
        const firstCall = latestToolCall(events.writes());
        const firstOps = (firstCall.input as { ops: Array<Record<string, unknown>> }).ops;
        const firstRun = firstOps.find((op) => op.type === "run_generation");
        const firstTarget = firstOps.find((op) => op.type === "add_node" && op.nodeType === "video");
        assert.equal(typeof firstRun?.clientOperationId, "string");
        assert.equal(firstRun?.clientOperationId, input.clientOperationId);
        session.resolveResult({ requestId: firstCall.requestId, result: { accepted: true } });
        await first;

        const second = session.callTool("canvas_generate_video", input);
        const secondCall = latestToolCall(events.writes());
        const secondOps = (secondCall.input as { ops: Array<Record<string, unknown>> }).ops;
        const secondRun = secondOps.find((op) => op.type === "run_generation");
        const secondTarget = secondOps.find((op) => op.type === "add_node" && op.nodeType === "video");
        assert.equal(secondRun?.clientOperationId, firstRun?.clientOperationId);
        assert.equal(secondTarget?.id, firstTarget?.id);
        session.resolveResult({ requestId: secondCall.requestId, result: { accepted: true } });
        await second;

        const writesBeforeReplay = events.writes().length;
        session.updateState({
            projectId: "generation-idempotency-canvas",
            nodes: [{
                id: String(firstTarget?.id),
                type: "video",
                title: "fixture clip",
                position: { x: 0, y: 0 },
                width: 320,
                height: 180,
                metadata: { ...(firstTarget?.metadata as Record<string, unknown>), taskId: "generation-idempotency-task", taskStatus: "queued", status: "loading" },
            }],
        }, clientId);
        const replay = await session.callTool("canvas_generate_video", input) as Record<string, unknown>;
        assert.equal(replay.idempotentReplay, true);
        assert.equal(replay.clientOperationId, firstRun?.clientOperationId);
        assert.equal(events.writes().length, writesBeforeReplay);

        const writesBeforeConflict = events.writes().length;
        await assert.rejects(
            session.callTool("canvas_generate_video", { ...input, prompt: "A materially different fixture clip" }),
            /已用于不同生成请求/,
        );
        assert.equal(events.writes().length, writesBeforeConflict, "a changed prompt must not submit another paid operation under the same ID");
    } finally {
        session.dispose();
    }
});

test("CanvasSession does not mistake a prepared idle node for a submitted generation", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    const clientId = "prepared-generation-client";
    const clientOperationId = "sample-h3-i2v-landscape-prepared";
    session.openEvents(new URL(`http://127.0.0.1/events?clientId=${clientId}`), events.response as never);
    session.updateState({
        projectId: "prepared-generation-canvas",
        nodes: [{
            id: "prepared-video",
            type: "video",
            title: "Prepared I2V sample",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: { generationMode: "video", status: "idle", clientOperationId },
        }],
    }, clientId);

    try {
        const submitted = session.callTool("canvas_run_generation", {
            nodeId: "prepared-video",
            mode: "video",
            prompt: "Animate the existing landscape frame with a slow camera move",
            clientOperationId,
        });
        const call = latestToolCall(events.writes());
        const ops = (call.input as { ops: Array<Record<string, unknown>> }).ops;
        assert.equal(ops.some((op) => op.type === "run_generation" && op.nodeId === "prepared-video" && op.clientOperationId === clientOperationId), true);
        session.resolveResult({ requestId: call.requestId, result: { accepted: true, taskId: "sample-task" } });
        await submitted;
    } finally {
        session.dispose();
    }
});

test("CanvasSession recognizes an accepted generation from its persisted task client id", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    const clientId = "persisted-task-generation-client";
    const clientOperationId = "sample-h3-i2v-landscape-persisted";
    session.openEvents(new URL(`http://127.0.0.1/events?clientId=${clientId}`), events.response as never);
    session.updateState({
        projectId: "persisted-task-generation-canvas",
        nodes: [{
            id: "persisted-video",
            type: "video",
            title: "Accepted I2V sample",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: { generationMode: "video", status: "loading", taskClientOperationId: clientOperationId, taskId: "persisted-generation-task", taskStatus: "queued" },
        }],
    }, clientId);

    const writesBeforeReplay = events.writes().length;
    try {
        const replay = await session.callTool("canvas_run_generation", {
            nodeId: "persisted-video",
            mode: "video",
            prompt: "Animate the existing landscape frame with a slow camera move",
            clientOperationId,
        }) as Record<string, unknown>;
        assert.equal(replay.idempotentReplay, true);
        assert.equal(replay.taskId, "persisted-generation-task");
        assert.equal(events.writes().length, writesBeforeReplay);
    } finally {
        session.dispose();
    }
});

test("Canvas generation tools emit generic run operations and preserve product configuration values", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=agent-client"), events.response as never);
    session.updateState({
        nodes: [{ id: "existing-image", type: "image", title: "Existing", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { generationMode: "image" } }],
    }, "agent-client");

    try {
        const generated = session.callTool("canvas_generate_video", { prompt: "A short test clip", seconds: "4", vquality: "720" });
        const generateCall = latestToolCall(events.writes());
        const generateOps = (generateCall.input as { ops: Array<Record<string, unknown>> }).ops;
        const target = generateOps.find((op) => op.type === "add_node" && op.nodeType === "video");
        const run = generateOps.find((op) => op.type === "run_generation");
        assert.equal((target?.metadata as Record<string, unknown>)?.vquality, "720");
        assert.deepEqual(run && { type: run.type, nodeId: run.nodeId, mode: run.mode }, { type: "run_generation", nodeId: target?.id, mode: "video" });
        session.resolveResult({ requestId: generateCall.requestId, result: { accepted: true } });
        await generated;

        const rerun = session.callTool("canvas_run_generation", { nodeId: "existing-image", mode: "image", prompt: "Retry image", retry: true });
        const rerunCall = latestToolCall(events.writes());
        const rerunOps = (rerunCall.input as { ops: Array<Record<string, unknown>> }).ops;
        assert.deepEqual(rerunOps[0], {
            type: "run_generation",
            nodeId: "existing-image",
            mode: "image",
            prompt: "Retry image",
            retry: true,
            clientOperationId: rerunOps[0]?.clientOperationId,
        });
        assert.match(String(rerunOps[0]?.clientOperationId), /^canvas:[a-f0-9]{64}$/);
        session.resolveResult({ requestId: rerunCall.requestId, result: { accepted: true } });
        await rerun;
    } finally {
        session.dispose();
    }
});

test("MCP I2V video fields preserve the requested contract and mark the connected first frame", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=i2v-client"), events.response as never);
    session.updateState({
        nodes: [{ id: "first-frame", type: "image", title: "Landscape first frame", position: { x: 0, y: 0 }, width: 560, height: 315, metadata: { generationMode: "image" } }],
    }, "i2v-client");

    try {
        const generated = session.callTool("canvas_generate_video", {
            prompt: "Preserve the landscape first frame and add subtle movement",
            model: "CHANNEL_000002::minimax_h3_z0902",
            videoOperation: "image_to_video",
            videoRatio: "16:9",
            videoResolution: "1088P",
            videoSeconds: 5,
            videoStartFrameNodeId: "first-frame",
        });
        const call = latestToolCall(events.writes());
        const ops = (call.input as { ops: Array<Record<string, unknown>> }).ops;
        const target = ops.find((op) => op.type === "add_node" && op.nodeType === "video");
        const metadata = target?.metadata as Record<string, unknown>;
        assert.equal(metadata.model, "CHANNEL_000002::minimax_h3_z0902");
        assert.equal(metadata.videoEditOperation, "image_to_video");
        assert.equal(metadata.videoStartFrameNodeId, "first-frame");
        assert.equal(metadata.size, "16:9");
        assert.equal(metadata.vquality, "1088P");
        assert.equal(metadata.seconds, "5");
        assert.ok(ops.some((op) => op.type === "connect_nodes" && op.fromNodeId === "first-frame" && op.toNodeId === target?.id));
        assert.ok(ops.some((op) => op.type === "run_generation" && op.nodeId === target?.id && op.mode === "video"));
        session.resolveResult({ requestId: call.requestId, result: { accepted: true } });
        await generated;
    } finally {
        session.dispose();
    }
});

function fixtureConfig(): LocalRuntimeConfig {
    return {
        url: endpoint,
        token,
        ownerId: "owner-canvas-fixture-001",
        origins: [origin],
        trustedWebOrigins: [origin],
        browserRegistrations: [],
        canvases: {},
    };
}

function sessionFixture(calls: Array<string | { name: string; value?: unknown }>) {
    return {
        health: () => ({ ok: true, hasCanvas: false, clients: 0 }),
        openEvents: (url: URL, res: { status(code: number): unknown; end(): void }) => {
            calls.push({
                name: "events",
                value: { clientId: url.searchParams.get("clientId"), token: url.searchParams.get("token") },
            });
            res.status(204);
            res.end();
        },
        updateState: (value: unknown) => { calls.push({ name: "state", value }); },
        resolveResult: (value: unknown, clientId: string) => { calls.push({ name: "result", value: { body: value, clientId } }); return true; },
        emitAll: () => undefined,
        callTool: async (name: unknown, value: unknown) => {
            calls.push({ name: String(name), value });
            return { accepted: true };
        },
        closeRuntimeSession: (sessionId: string) => { calls.push({ name: "revoke", value: sessionId }); },
        dispose: () => { calls.push("dispose"); },
    };
}

function jsonHeaders() {
    return { Host: authority, Origin: origin, "Content-Type": "application/json" };
}

function request(
    server: Server,
    options: { method?: string; path: string; headers: Record<string, string>; body?: string },
) {
    const address = server.address();
    assert(address && typeof address === "object");
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
            hostname: "127.0.0.1",
            port: address.port,
            method: options.method ?? "GET",
            path: options.path,
            headers: options.headers,
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        });
        req.once("error", reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

function eventResponse() {
    const writes: string[] = [];
    const response = new EventEmitter() as EventEmitter & {
        writeHead(): void;
        write(chunk: unknown): void;
        end(): void;
    };
    let ended = 0;
    response.writeHead = () => undefined;
    response.write = (chunk) => { writes.push(String(chunk)); };
    response.end = () => { ended += 1; };
    return { response, ended: () => ended, writes: () => [...writes] };
}

function latestToolCall(writes: string[]) {
    const event = [...writes].reverse().find((value) => value.startsWith("event: tool_call\n"));
    assert.ok(event);
    const data = event.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(data);
    return JSON.parse(data.slice("data: ".length)) as { requestId: string; name: string; input: unknown };
}

test("canvas_delete_nodes also clears storyboard row connections that keep both endpoints", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=storyboard-delete"), events.response as never);
    const initial: CanvasSnapshot = {
        projectId: "canvas-delete",
        revision: 2,
        nodes: [
            { id: "script-1", type: "script", title: "分镜表", position: { x: 0, y: 0 }, width: 800, height: 400, metadata: { storyboard: { rows: [{ id: "row-1", shotNumber: 1, durationSeconds: 5, imageNodeId: "image-1", videoNodeId: "video-1" }], visibleColumns: [], referenceNodeIds: [] } } },
            { id: "image-1", type: "image", title: "首帧", position: { x: 900, y: 0 }, width: 320, height: 240, metadata: { status: "success" } },
            { id: "video-1", type: "video", title: "视频", position: { x: 1300, y: 0 }, width: 320, height: 240, metadata: { status: "success" } },
        ],
        connections: [
            { id: "edge-row-output", fromNodeId: "script-1", toNodeId: "video-1", fromHandleId: "row:row-1", relation: "storyboard-output", storyboardRowId: "row-1" },
            { id: "edge-asset-reference", fromNodeId: "image-1", toNodeId: "video-1", relation: "storyboard-asset-reference", storyboardRowId: "row-1" },
            { id: "edge-unrelated", fromNodeId: "image-1", toNodeId: "script-1" },
        ],
        viewport: { x: 0, y: 0, k: 1 },
    };
    session.updateState(initial, "storyboard-delete");
    try {
        const pending = session.callTool("canvas_delete_nodes", { ids: ["script-1"] });
        const call = latestToolCall(events.writes());
        const input = call.input as { ops: Array<Record<string, unknown>> };
        const deletedEdges = input.ops
            .filter((op) => op.type === "delete_connections")
            .flatMap((op) => (Array.isArray(op.ids) ? op.ids.map(String) : []));
        assert.ok(deletedEdges.includes("edge-asset-reference"), `asset reference edge must be deleted: ${JSON.stringify(input.ops)}`);
        assert.ok(!deletedEdges.includes("edge-row-output"), "与节点相连的边由 delete_node 清理，不重复提交");
        assert.ok(!deletedEdges.includes("edge-unrelated"), "无关连线不能被删除");
        assert.ok(input.ops.some((op) => op.type === "delete_node"));

        session.resolveResult({ requestId: call.requestId, result: applyStoryboardOpsFixture(initial, input) });
        await pending;

        const state = await session.callTool("canvas_get_state", {}) as { connections: Array<{ id: string }> };
        const ids = new Set((state.connections || []).map((connection) => connection.id));
        assert.equal(ids.has("edge-asset-reference"), false, "指向已删除行的资产参考边不能残留");
        assert.equal(ids.has("edge-row-output"), false);
        assert.equal(ids.has("edge-unrelated"), false);
    } finally {
        session.dispose();
    }
});

function applyStoryboardOpsFixture(snapshot: CanvasSnapshot, input: { ops: Array<Record<string, unknown>> }) {
    let nodes = [...(snapshot.nodes || [])];
    let connections = [...(snapshot.connections || [])];
    for (const op of input.ops) {
        if (op.type === "update_node") {
            const id = String(op.id || "");
            const metadata = op.metadata && typeof op.metadata === "object" && !Array.isArray(op.metadata) ? op.metadata as Record<string, unknown> : {};
            nodes = nodes.map((node) => node.id === id ? { ...node, metadata: { ...node.metadata, ...metadata } } : node);
        } else if (op.type === "delete_node") {
            const ids = new Set([...(Array.isArray(op.ids) ? op.ids.map(String) : []), ...(typeof op.id === "string" ? [op.id] : [])]);
            nodes = nodes.filter((node) => !ids.has(node.id));
            connections = connections.filter((connection) => !ids.has(connection.fromNodeId) && !ids.has(connection.toNodeId));
        } else if (op.type === "delete_connections") {
            const ids = new Set(Array.isArray(op.ids) ? op.ids.map(String) : []);
            connections = connections.filter((connection) => !ids.has(connection.id));
        } else if (op.type === "connect_nodes") {
            const fromNodeId = String(op.fromNodeId || "");
            const toNodeId = String(op.toNodeId || "");
            const fromHandleId = typeof op.fromHandleId === "string" ? op.fromHandleId : undefined;
            const toHandleId = typeof op.toHandleId === "string" ? op.toHandleId : undefined;
            const relation = typeof op.relation === "string" ? op.relation as NonNullable<CanvasSnapshot["connections"]>[number]["relation"] : undefined;
            const storyboardRowId = typeof op.storyboardRowId === "string" ? op.storyboardRowId : undefined;
            const exists = connections.some((connection) => connection.fromNodeId === fromNodeId
                && connection.toNodeId === toNodeId
                && connection.fromHandleId === fromHandleId
                && connection.toHandleId === toHandleId
                && connection.relation === relation
                && connection.storyboardRowId === storyboardRowId);
            if (!exists) connections.push({ id: String(op.id || `fixture-edge-${connections.length + 1}`), fromNodeId, toNodeId, fromHandleId, toHandleId, relation, storyboardRowId });
        }
    }
    return { ok: true, snapshot: { ...snapshot, nodes, connections, revision: (snapshot.revision ?? 0) + 1 } };
}

test("storyboard removes duplicate direct picture wires when associating the same asset", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=dedupe-picture"), events.response as never);
    const initial: CanvasSnapshot = {
        projectId: "canvas-1", revision: 4,
        nodes: [
            { id: "script", type: "script", position: { x: 800, y: 0 }, metadata: { storyboard: { rows: [{ id: "row", shotNumber: 1, durationSeconds: 8, imageNodeId: "first", assetBindings: [{ nodeId: "person", role: "character", priority: 100 }] }], visibleColumns: [], referenceNodeIds: [] } } },
            { id: "person", type: "image", position: { x: 0, y: 0 }, metadata: { status: "success", storageKey: "resource:person" } },
            { id: "first", type: "image", position: { x: 400, y: 0 }, metadata: { status: "success", storageKey: "resource:first" } },
            { id: "other", type: "image", position: { x: 0, y: 400 }, metadata: { status: "success", storageKey: "resource:other" } },
        ],
        connections: [{ id: "manual-person", fromNodeId: "person", toNodeId: "first" }, { id: "manual-other", fromNodeId: "other", toNodeId: "first" }],
    };
    session.updateState(initial, "dedupe-picture");
    try {
        for (let iteration = 0; iteration < 2; iteration++) {
            const before = await session.callTool("canvas_get_storyboard", { nodeId: "script" }) as { revision: number; stateHash: string };
            const pending = session.callTool("canvas_update_storyboard", { expectedCanvasId: "canvas-1", expectedRevision: before.revision, expectedStateHash: before.stateHash, nodeId: "script", mode: "merge", rows: [{ id: "row", plotDescription: "single reference" }] });
            const call = latestToolCall(events.writes());
            const { stateHash: _previousHash, ...state } = await session.callTool("canvas_get_state", {}) as CanvasSnapshot;
            const applied = applyStoryboardOpsFixture(state, call.input as { ops: Array<Record<string, unknown>> });
            session.resolveResult({ requestId: call.requestId, result: applied });
            await pending;
            assert.equal(applied.snapshot.connections.filter((edge) => edge.fromNodeId === "person" && edge.toNodeId === "first").length, 1);
            assert.ok(applied.snapshot.connections.some((edge) => edge.id === "manual-other"), "unrelated manual references must remain");
        }
    } finally { session.dispose(); }
});

function listening(server: Server) {
    if (server.listening) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
}

function close(server: Server) {
    return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("CanvasSession rejects stale state revisions and accepts idempotent retries", () => {
    const session = new FixtureCanvasSession();
    const first = session.updateState({ projectId: "canvas-1", nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 } }, "fixture");
    assert.equal(first.accepted, true);
    assert.equal(first.revision, 0);

    const idempotent = session.updateState({ projectId: "canvas-1", nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 }, revision: 0 }, "fixture");
    assert.equal(idempotent.accepted, true);
    assert.equal(idempotent.idempotent, true);

    const conflict = session.updateState({ projectId: "canvas-1", nodes: [{ id: "n-1", type: "text", position: { x: 0, y: 0 }, width: 100, height: 100 }], connections: [], viewport: { x: 0, y: 0, k: 1 }, revision: 0 }, "fixture");
    assert.equal(conflict.accepted, false);
    assert.equal(conflict.reason, "revision_conflict");

    const next = session.updateState({ projectId: "canvas-1", nodes: [{ id: "n-1", type: "text", position: { x: 0, y: 0 }, width: 100, height: 100 }], connections: [], viewport: { x: 0, y: 0, k: 1 }, revision: 1 }, "fixture");
    assert.equal(next.accepted, true);
    assert.equal(next.revision, 1);

    const stale = session.updateState({ projectId: "canvas-1", nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 }, revision: 0 }, "fixture");
    assert.equal(stale.accepted, false);
    assert.equal(stale.reason, "stale_revision");
    session.dispose();
});


test("canvas_apply_ops enforces expected revision and state hash before dispatch", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=guarded-write"), events.response as never);
    session.updateState({ nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 } }, "guarded-write");
    const context = buildCanvasContext({ projectId: "fixture-canvas-guarded-write", nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 }, revision: 0, clientId: "guarded-write" });
    try {
        const accepted = session.callTool("canvas_apply_ops", { ops: [], expectedCanvasId: "fixture-canvas-guarded-write", expectedRevision: 0, expectedStateHash: context.stateHash });
        const call = latestToolCall(events.writes());
        session.resolveResult({ requestId: call.requestId, result: { accepted: true } });
        assert.deepEqual(await accepted, { accepted: true });

        const writeCount = events.writes().length;
        await assert.rejects(
            session.callTool("canvas_apply_ops", { ops: [], expectedCanvasId: "fixture-canvas-guarded-write", expectedRevision: 1, expectedStateHash: context.stateHash }),
            /画布状态已变化.*重新读取 canvas_get_context/
        );
        const writeCountAfterSameState = events.writes().length;
        assert.equal(writeCountAfterSameState, writeCount);
        await assert.rejects(
            session.callTool("canvas_apply_ops", { ops: [], expectedCanvasId: "fixture-canvas-guarded-write", expectedRevision: 0 }),
            /expectedStateHash|画布状态已变化/
        );
        assert.equal(events.writes().length, writeCountAfterSameState);
        await assert.rejects(
            session.callTool("canvas_apply_ops", { ops: [], expectedCanvasId: "fixture-canvas-guarded-write", expectedRevision: 0, expectedStateHash: "bad-hash" }),
            /画布状态已变化.*重新读取 canvas_get_context/
        );
        assert.equal(events.writes().length, writeCountAfterSameState);
    } finally {
        session.dispose();
    }
});

test("canvas_get_storyboard 读取画布真实 Script 分镜行", async () => {
    const session = new FixtureCanvasSession();
    session.updateState({
        nodes: [{
            id: "script-1",
            type: "script",
            title: "分镜表",
            position: { x: 0, y: 0 },
            width: 800,
            height: 400,
            metadata: { storyboard: { rows: [{ id: "shot-1", shotNumber: 1, durationSeconds: 6, plotDescription: "开场" }], visibleColumns: ["shotNumber", "plotDescription"], referenceNodeIds: ["char-1"] } },
        }],
        connections: [],
    }, "fixture");
    const result = await session.callTool("canvas_get_storyboard", {}) as {
        storyboards: Array<{ nodeId: string; rows: Array<Record<string, unknown>>; referenceNodeIds: string[] }>;
        hint: string;
    };
    assert.equal(result.storyboards.length, 1);
    assert.equal(result.storyboards[0].nodeId, "script-1");
    assert.equal(result.storyboards[0].rows.length, 1);
    assert.equal(result.storyboards[0].rows[0].plotDescription, "开场");
    assert.deepEqual(result.storyboards[0].referenceNodeIds, ["char-1"]);
    assert.equal(typeof (result as { revision?: number }).revision, "number");
    assert.match(String((result as { stateHash?: string }).stateHash || ""), /^[a-f0-9]{16}$/);
    assert.match(result.hint, /稳定 rowId/);
    session.dispose();
});

test("storyboard schema preserves output, status, segment bindings, and rejects unknown fields", () => {
    const input = {
        expectedCanvasId: "storyboard-canvas",
        expectedRevision: 1,
        expectedStateHash: "expected-state-hash",
        rows: [{
            id: "row-1",
            sceneId: "scene-1",
            shotNumber: 1,
            voiceover: "旁白保留",
            imageNodeId: "image-1",
            videoNodeId: "video-1",
            status: "ready",
            errorDetails: "",
            imagePromptTemplateVariables: { wardrobe: "blue coat" },
            videoPromptTemplateVariables: { movement: "pan left" },
            segmentBindings: [{
                segmentId: "row-1-segment-0",
                order: 0,
                videoNodeId: "video-segment-1",
                taskId: "task-1",
                resourceId: "resource-1",
                stepId: "step-1",
                attemptId: "attempt-1",
                relayReferenceNodeId: "video-segment-0",
                requestedDurationSeconds: 12,
                timelineStartMs: 0,
                timelineDurationMs: 12_000,
                status: "succeeded",
            }],
        }],
    };
    const parsed = toolInputSchemas.canvas_update_storyboard.safeParse(input);
    assert.equal(parsed.success, true);
    if (parsed.success) {
        assert.equal(parsed.data.rows[0].imageNodeId, "image-1");
        assert.equal(parsed.data.rows[0].videoNodeId, "video-1");
        assert.equal(parsed.data.rows[0].sceneId, "scene-1");
        assert.equal(parsed.data.rows[0].voiceover, "旁白保留");
        assert.equal(parsed.data.rows[0].status, "ready");
        assert.equal(parsed.data.rows[0].segmentBindings?.[0].resourceId, "resource-1");
        assert.deepEqual(parsed.data.rows[0].imagePromptTemplateVariables, { wardrobe: "blue coat" });
    }
    assert.equal(toolInputSchemas.canvas_update_storyboard.safeParse({ rows: [{ shotNumber: 1, criticalTypo: "must not disappear" }] }).success, false);
});

test("storyboard merge matches stable row id before shot number and supports explicit clears", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=storyboard-id-merge"), events.response as never);
    let snapshot: CanvasSnapshot = {
        nodes: [{
            id: "script-1", type: "script", title: "分镜表", position: { x: 0, y: 0 }, width: 800, height: 400,
            metadata: { storyboard: { rows: [
                { id: "row-a", shotNumber: 1, durationSeconds: 4, plotDescription: "A" },
                { id: "row-b", shotNumber: 2, durationSeconds: 7, plotDescription: "B", imageNodeId: "image-b", videoNodeId: "video-b", status: "success", assetBindings: [{ nodeId: "asset-b", role: "character", priority: 100 }], segmentBindings: [{ segmentId: "b-0", order: 0, videoNodeId: "video-b", taskId: "task-b", resourceId: "resource-b", status: "succeeded" }] },
            ], visibleColumns: ["shotNumber"], referenceNodeIds: [] } },
        },
        { id: "image-b", type: "image", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { status: "success", resourceId: "image-resource-b" } },
        { id: "video-b", type: "video", position: { x: 120, y: 0 }, width: 100, height: 100, metadata: { status: "success", taskId: "task-b", taskStatus: "succeeded", resourceId: "resource-b" } },
        { id: "asset-b", type: "image", position: { x: 240, y: 0 }, width: 100, height: 100, metadata: { status: "success", resourceId: "asset-resource-b" } }],
        connections: [],
    };
    session.updateState(snapshot, "storyboard-id-merge");
    try {
        const initialContext = buildCanvasContext(snapshot);
        const writeCountBeforeUnsafeReplace = events.writes().length;
        await assert.rejects(session.callTool("canvas_update_storyboard", {
            mode: "replace",
            expectedRevision: initialContext.revision,
            expectedStateHash: initialContext.stateHash,
            rows: [{ shotNumber: 1, plotDescription: "缺少稳定 ID 的替换" }],
        }), /replace.*稳定 rowId/);
        assert.equal(events.writes().length, writeCountBeforeUnsafeReplace);
        const pending = session.callTool("canvas_update_storyboard", {
            mode: "merge",
            expectedRevision: initialContext.revision,
            expectedStateHash: initialContext.stateHash,
            rows: [{ id: "row-b", shotNumber: 1, plotDescription: "B moved first" }],
        });
        const call = latestToolCall(events.writes());
        assert.equal((call.input as { expectedRevision: number }).expectedRevision, initialContext.revision);
        const rows = (call.input as { ops: Array<{ metadata: { storyboard: { rows: Array<Record<string, unknown>> } } }> }).ops[0].metadata.storyboard.rows;
        assert.deepEqual(rows.map((row) => row.id), ["row-a", "row-b"]);
        assert.equal(rows[0].plotDescription, "A");
        assert.equal(rows[1].shotNumber, 1);
        assert.equal(rows[1].plotDescription, "B moved first");
        assert.equal(rows[1].imageNodeId, "image-b");
        assert.equal(rows[1].videoNodeId, "video-b");
        assert.equal(rows[1].status, "success");
        assert.equal((rows[1].segmentBindings as Array<Record<string, unknown>>)[0].taskId, "task-b");
        const firstResult = applyStoryboardOpsFixture(snapshot, call.input as { ops: Array<Record<string, unknown>> });
        session.resolveResult({ requestId: call.requestId, result: firstResult });
        snapshot = firstResult.snapshot;
        await pending;

        const currentContext = await session.callTool("canvas_get_context", {}) as { revision: number; stateHash: string };
        const clear = session.callTool("canvas_update_storyboard", {
            mode: "merge",
            expectedRevision: currentContext.revision,
            expectedStateHash: currentContext.stateHash,
            rows: [{ id: "row-b", imageNodeId: null, videoNodeId: null, status: null, assetBindings: null, segmentBindings: null }],
        });
        const clearCall = latestToolCall(events.writes());
        const cleared = (clearCall.input as { ops: Array<{ metadata: { storyboard: { rows: Array<Record<string, unknown>> } } }> }).ops[0].metadata.storyboard.rows[1];
        assert.equal(cleared.imageNodeId, undefined);
        assert.equal(cleared.videoNodeId, undefined);
        assert.equal(cleared.status, "idle");
        assert.deepEqual(cleared.assetBindings, []);
        assert.deepEqual(cleared.segmentBindings, []);
        const clearResult = applyStoryboardOpsFixture(snapshot, clearCall.input as { ops: Array<Record<string, unknown>> });
        session.resolveResult({ requestId: clearCall.requestId, result: clearResult });
        await clear;
    } finally {
        session.dispose();
    }
});

test("storyboard output bindings commit atomically and read back row, task, resource, and connections", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=storyboard-roundtrip"), events.response as never);
    const initial = {
        projectId: "canvas-1",
        revision: 4,
        nodes: [
            { id: "script-1", type: "script", title: "分镜表", position: { x: 0, y: 0 }, width: 800, height: 400, metadata: { storyboard: { rows: [{ id: "row-1", sceneId: "scene-1", shotNumber: 1, durationSeconds: 10, plotDescription: "原剧情", dialogue: "手工对白", voiceover: "手工旁白", imageNodeId: "image-1", videoNodeId: "video-1", status: "success", assetBindings: [{ nodeId: "asset-1", role: "character", priority: 100 }], requiredAssetRoles: ["character"], videoOperation: "text_to_video", segmentBindings: [{ segmentId: "row-1-seg-0", order: 0, videoNodeId: "video-1", taskId: "video-task-1", resourceId: "video-resource-1", stepId: "video-step-1", attemptId: "video-attempt-1", model: "CHANNEL_000002::minimax_h3_b99_003_12s", capabilityRevision: "CHANNEL_000002::minimax_h3_b99_003_12s:3", requestedDurationSeconds: 10, timelineStartMs: 0, timelineDurationMs: 10000, status: "succeeded" }] }], visibleColumns: ["shotNumber"], referenceNodeIds: [] } } },
            { id: "image-1", type: "image", title: "首帧", position: { x: 900, y: 0 }, width: 320, height: 240, metadata: { status: "success", taskId: "image-task-1", taskStatus: "succeeded", resourceId: "image-resource-1", storageKey: "fixture/image.png" } },
            { id: "video-1", type: "video", title: "分镜视频", position: { x: 1300, y: 0 }, width: 320, height: 240, metadata: { status: "success", taskId: "video-task-1", taskStatus: "succeeded", resourceId: "video-resource-1", storageKey: "fixture/video.mp4", model: "CHANNEL_000002::minimax_h3_b99_003_12s" } },
            { id: "asset-1", type: "image", title: "角色资产", position: { x: 500, y: 0 }, width: 320, height: 240, metadata: { status: "success", storageKey: "resource:asset-resource-1" } },
        ],
        connections: [],
        viewport: { x: 0, y: 0, k: 1 },
    };
    session.updateState(initial, "storyboard-roundtrip");
    try {
        const before = await session.callTool("canvas_get_storyboard", { nodeId: "script-1" }) as { revision: number; stateHash: string; storyboards: Array<{ rows: Array<Record<string, unknown>> }> };
        const pending = session.callTool("canvas_update_storyboard", {
            nodeId: "script-1",
            mode: "merge",
            expectedRevision: before.revision,
            expectedStateHash: before.stateHash,
            rows: [{ id: "row-1", plotDescription: "回写后的剧情" }],
        });
        const call = latestToolCall(events.writes());
        const input = call.input as { expectedRevision: number; expectedStateHash: string; ops: Array<Record<string, unknown>> };
        assert.equal(input.expectedRevision, 4);
        assert.equal(input.expectedStateHash, before.stateHash);
        const connections = input.ops.filter((op) => op.type === "connect_nodes");
        assert.equal(connections.length, 3);
        assert.equal(connections.some((op) => op.fromNodeId === "script-1" && op.toNodeId === "image-1"), false);
        assert.ok(connections.some((op) => op.fromNodeId === "asset-1" && op.toNodeId === "image-1" && op.relation === "storyboard-asset-reference" && op.storyboardRowId === "row-1"));
        assert.ok(connections.some((op) => op.fromNodeId === "script-1" && op.toNodeId === "video-1" && op.relation === "storyboard-output" && op.storyboardRowId === "row-1"));
        assert.equal(connections.some((op) => op.fromNodeId === "asset-1" && op.toNodeId === "video-1"), false);
        assert.ok(connections.some((op) => op.fromNodeId === "asset-1" && op.toNodeId === "script-1" && op.toHandleId === "row:row-1" && op.relation === "storyboard-asset-reference" && op.storyboardRowId === "row-1"));
        const rows = (input.ops.find((op) => op.type === "update_node")?.metadata as { storyboard: { rows: Array<Record<string, unknown>> } }).storyboard.rows;
        assert.equal(rows[0].imageNodeId, "image-1");
        assert.equal(rows[0].videoNodeId, "video-1");
        assert.equal(rows[0].status, "success");
        assert.equal(rows[0].sceneId, "scene-1");
        assert.deepEqual(rows[0].requiredAssetRoles, ["character"]);
        assert.equal(rows[0].videoOperation, "text_to_video");
        assert.equal(rows[0].dialogue, "手工对白");
        assert.equal(rows[0].voiceover, "手工旁白");
        assert.equal((rows[0].segmentBindings as Array<Record<string, unknown>>)[0].resourceId, "video-resource-1");

        const nextNodes = initial.nodes.map((node) => node.id === "script-1"
            ? { ...node, metadata: { ...node.metadata, storyboard: { ...node.metadata.storyboard, rows, visibleColumns: ["shotNumber"], referenceNodeIds: [] } } }
            : node);
        const nextConnections = connections.map((op) => ({ id: String(op.id), fromNodeId: String(op.fromNodeId), toNodeId: String(op.toNodeId), fromHandleId: op.fromHandleId as string | undefined, toHandleId: op.toHandleId as string | undefined, relation: op.relation as "storyboard-output" | "storyboard-asset-reference", storyboardRowId: String(op.storyboardRowId) }));
        const nextSnapshot = { ...initial, revision: 5, nodes: nextNodes, connections: nextConnections, clientId: "storyboard-roundtrip" };
        session.resolveResult({ requestId: call.requestId, result: { ok: true, snapshot: nextSnapshot } });
        await pending;

        const after = await session.callTool("canvas_get_storyboard", { nodeId: "script-1" }) as { revision: number; storyboards: Array<{ rows: Array<Record<string, unknown>> }> };
        const row = after.storyboards[0].rows[0];
        assert.equal(after.revision, 5);
        assert.equal(row.plotDescription, "回写后的剧情");
        assert.equal(row.imageNodeId, "image-1");
        assert.equal(row.videoNodeId, "video-1");
        assert.equal(row.status, "success");
        assert.equal(row.sceneId, "scene-1");
        assert.deepEqual(row.requiredAssetRoles, ["character"]);
        assert.equal(row.videoOperation, "text_to_video");
        assert.equal(row.dialogue, "手工对白");
        assert.equal(row.voiceover, "手工旁白");
        const bindingState = row.bindingState as { rowTrace: { traceConsistent: boolean; traceIssues: string[] }; image: Record<string, unknown>; video: Record<string, unknown>; assets: Array<Record<string, unknown>>; connections: Array<Record<string, unknown>> };
        assert.equal(bindingState.rowTrace.traceConsistent, true);
        assert.deepEqual(bindingState.rowTrace.traceIssues, []);
        assert.equal(bindingState.image.taskId, "image-task-1");
        assert.equal(bindingState.image.resourceId, "image-resource-1");
        assert.equal(bindingState.video.taskId, "video-task-1");
        assert.equal(bindingState.video.resourceId, "video-resource-1");
        assert.equal(bindingState.assets[0].resourceId, "asset-resource-1");
        assert.equal(bindingState.assets[0].resourceReady, true);
        assert.equal(bindingState.connections.length, 3);
        const segment = (bindingState as typeof bindingState & { segments: Array<Record<string, unknown>> }).segments[0];
        assert.equal(segment.traceConsistent, true);
        assert.deepEqual(segment.traceIssues, []);

        const state = await session.callTool("canvas_get_state", {}) as { revision: number; stateHash: string; nodes: Array<{ id: string; metadata: { storyboard?: { rows: Array<Record<string, unknown>> } } }> };
        const node = await session.callTool("canvas_get_node", { id: "script-1" }) as { revision: number; stateHash: string; node: { metadata?: { storyboard?: { rows: Array<Record<string, unknown>> } } }; connections: Array<{ relation?: string; storyboardRowId?: string }> };
        assert.equal(node.revision, state.revision);
        assert.equal(node.stateHash, state.stateHash);
        assert.equal(node.node.metadata?.storyboard?.rows[0].imageNodeId, row.imageNodeId);
        assert.equal(state.nodes.find((item) => item.id === "script-1")?.metadata.storyboard?.rows[0].videoNodeId, row.videoNodeId);
        assert.ok(node.connections.some((connection) => connection.relation === "storyboard-output" && connection.storyboardRowId === "row-1"));
        const connectionId = String(bindingState.connections.find((item) => item.relation === "storyboard-output")!.id);
        const connection = await session.callTool("canvas_get_connection", { id: connectionId }) as { connection: { relation?: string; storyboardRowId?: string } };
        assert.equal(connection.connection.relation, "storyboard-output");
        assert.equal(connection.connection.storyboardRowId, "row-1");

        const writeCount = events.writes().length;
        await assert.rejects(session.callTool("canvas_update_storyboard", { nodeId: "script-1", mode: "replace", expectedRevision: 4, expectedStateHash: before.stateHash, rows: [{ id: "row-1", shotNumber: 1 }] }), /revision.*重新读取 canvas_get_context/);
        assert.equal(events.writes().length, writeCount);
    } finally {
        session.dispose();
    }
});

test("canvas_update_storyboard syncs pending row prompts and references without touching completed outputs", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=storyboard-prompt-sync"), events.response as never);
    const initial: CanvasSnapshot = {
        projectId: "canvas-storyboard-prompt-sync",
        revision: 3,
        nodes: [
            { id: "script", type: "script", position: { x: 0, y: 0 }, width: 700, height: 400, metadata: { storyboard: { rows: [
                { id: "row-a", shotNumber: 1, durationSeconds: 6, plotDescription: "旧 A", imageGenerationPrompt: "旧 A image", videoMotionPrompt: "旧 A video", imageNodeId: "image-a", videoNodeId: "video-a", assetBindings: [{ nodeId: "character-a", role: "character", priority: 100 }, { nodeId: "scene-a", role: "environment", priority: 90 }, { nodeId: "scene-a", role: "prop", priority: 80 }] },
                { id: "row-b", shotNumber: 2, durationSeconds: 6, plotDescription: "旧 B", imageGenerationPrompt: "旧 B image", videoMotionPrompt: "旧 B video", imageNodeId: "image-b", videoNodeId: "video-b", assetBindings: [{ nodeId: "character-b", role: "character", priority: 100 }, { nodeId: "scene-b", role: "environment", priority: 90 }] },
                { id: "row-c", shotNumber: 3, durationSeconds: 6, plotDescription: "已完成", videoMotionPrompt: "旧完成提示词", videoNodeId: "video-c" },
            ], visibleColumns: ["shotNumber"], referenceNodeIds: [] } } },
            { id: "character-a", type: "image", title: "人物 A", position: { x: 800, y: 0 }, width: 320, height: 240, metadata: { workflowKind: "character", content: "resource:character-a" } },
            { id: "scene-a", type: "image", title: "场景 A", position: { x: 800, y: 300 }, width: 320, height: 240, metadata: { content: "resource:scene-a" } },
            { id: "character-b", type: "image", title: "人物 B", position: { x: 800, y: 600 }, width: 320, height: 240, metadata: { workflowKind: "character", content: "resource:character-b" } },
            { id: "scene-b", type: "image", title: "场景 B", position: { x: 800, y: 900 }, width: 320, height: 240, metadata: { content: "resource:scene-b" } },
            { id: "image-a", type: "image", position: { x: 1200, y: 0 }, width: 320, height: 240, metadata: { status: "idle", prompt: "old", composerContent: "old" } },
            { id: "video-a", type: "video", position: { x: 1600, y: 0 }, width: 320, height: 240, metadata: { status: "idle", prompt: "old", composerContent: "old" } },
            { id: "image-b", type: "image", position: { x: 1200, y: 300 }, width: 320, height: 240, metadata: { status: "idle", prompt: "old", composerContent: "old" } },
            { id: "video-b", type: "video", position: { x: 1600, y: 300 }, width: 320, height: 240, metadata: { status: "idle", prompt: "old", composerContent: "old" } },
            { id: "video-c", type: "video", position: { x: 1600, y: 600 }, width: 320, height: 240, metadata: { status: "success", taskId: "finished-task", taskStatus: "succeeded", content: "resource:finished", prompt: "completed prompt", composerContent: "completed composer" } },
        ],
        connections: [],
        viewport: { x: 0, y: 0, k: 1 },
    };
    session.updateState(initial, "storyboard-prompt-sync");
    try {
        const before = await session.callTool("canvas_get_storyboard", { nodeId: "script" }) as { revision: number; stateHash: string };
        const pending = session.callTool("canvas_update_storyboard", {
            nodeId: "script",
            mode: "merge",
            expectedRevision: before.revision,
            expectedStateHash: before.stateHash,
            rows: [
                { id: "row-a", imageGenerationPrompt: "@[node:character-a] @[node:scene-a] 新 A 图片", videoMotionPrompt: "@[node:character-a] @[node:scene-a] 新 A 视频" },
                { id: "row-b", imageGenerationPrompt: "@[node:character-b] @[node:scene-b] 新 B 图片", videoMotionPrompt: "@[node:character-b] @[node:scene-b] 新 B 视频" },
                { id: "row-c", videoMotionPrompt: "不得覆盖完成结果" },
            ],
        });
        const call = latestToolCall(events.writes());
        const input = call.input as { ops: Array<Record<string, unknown>> };
        const outputUpdates = input.ops.filter((op) => op.type === "update_node" && ["image-a", "video-a", "image-b", "video-b"].includes(String(op.id)));
        assert.equal(outputUpdates.length, 4);
        const byNodeId = new Map(outputUpdates.map((op) => [String(op.id), op.metadata as Record<string, unknown>]));
        assert.equal(byNodeId.get("image-a")?.prompt, "@[node:character-a] @[node:scene-a] 新 A 图片");
        assert.equal(byNodeId.get("video-a")?.prompt, "@[node:character-a] @[node:scene-a] 新 A 视频");
        assert.equal(byNodeId.get("image-b")?.prompt, "@[node:character-b] @[node:scene-b] 新 B 图片");
        assert.equal(byNodeId.get("video-b")?.prompt, "@[node:character-b] @[node:scene-b] 新 B 视频");
        assert.equal(String(byNodeId.get("video-a")?.composerContent).includes("@[node:character-a]"), true);
        assert.equal(String(byNodeId.get("video-a")?.composerContent).includes("@[node:scene-a]"), true);
        assert.equal(String(byNodeId.get("video-b")?.composerContent).includes("@[node:character-b]"), true);
        assert.equal(String(byNodeId.get("video-b")?.composerContent).includes("@[node:scene-b]"), true);
        assert.equal(String(byNodeId.get("video-a")?.composerContent).includes("@[node:image-a]"), true);
        assert.equal(String(byNodeId.get("video-b")?.composerContent).includes("@[node:image-b]"), true);
        assert.equal(input.ops.some((op) => op.type === "connect_nodes" && op.fromNodeId === "script" && ["image-a", "image-b"].includes(String(op.toNodeId))), false);
        assert.equal(input.ops.some((op) => op.type === "connect_nodes" && op.relation === "storyboard-asset-reference" && ["video-a", "video-b"].includes(String(op.toNodeId))), false);
        assert.equal(input.ops.some((op) => op.type === "update_node" && op.id === "video-c"), false);
        for (const [rowId, firstFrameId] of [["row-a", "image-a"], ["row-b", "image-b"]]) {
            assert.ok(input.ops.some((op) => op.type === "connect_nodes" && op.fromNodeId === firstFrameId && op.toNodeId === "script" && op.toHandleId === `row:${rowId}` && op.relation === "storyboard-asset-reference"));
        }
        for (const [rowId, assetIds] of [["row-a", ["character-a", "scene-a"]], ["row-b", ["character-b", "scene-b"]]] as const) {
            for (const assetId of assetIds) {
                assert.ok(input.ops.some((op) => op.type === "connect_nodes" && op.fromNodeId === assetId && op.toNodeId === "script" && op.toHandleId === `row:${rowId}` && op.storyboardRowId === rowId));
            }
        }
        assert.equal(input.ops.some((op) => op.type === "connect_nodes" && op.fromNodeId === "scene-a" && op.toNodeId === "video-b"), false);
        assert.equal(input.ops.some((op) => op.type === "connect_nodes" && op.fromNodeId === "scene-b" && op.toNodeId === "video-a"), false);

        const updatedNodes = initial.nodes!.map((node) => {
            const update = outputUpdates.find((op) => op.id === node.id);
            return update ? { ...node, metadata: { ...node.metadata, ...(update.metadata as Record<string, unknown>) } } : node;
        });
        const rowUpdate = input.ops.find((op) => op.type === "update_node" && op.id === "script")!;
        const rows = (rowUpdate.metadata as { storyboard: { rows: unknown[] } }).storyboard.rows;
        updatedNodes[0] = { ...updatedNodes[0]!, metadata: { ...updatedNodes[0]!.metadata, storyboard: { ...((updatedNodes[0]!.metadata?.storyboard) || {}), rows } } };
        const nextConnections = input.ops.flatMap((op) => op.type === "connect_nodes" ? [{
            id: String(op.id), fromNodeId: String(op.fromNodeId), toNodeId: String(op.toNodeId),
            fromHandleId: op.fromHandleId as string | undefined, toHandleId: op.toHandleId as string | undefined, relation: op.relation as "storyboard-output" | "storyboard-asset-reference",
            storyboardRowId: String(op.storyboardRowId),
        }] : []);
        session.resolveResult({ requestId: call.requestId, result: { ok: true, snapshot: { ...initial, revision: 4, nodes: updatedNodes, connections: nextConnections } } }, "storyboard-prompt-sync");
        await pending;

        // The command resolves only after its internal snapshot readback verifies
        // both pending output metadata and the unchanged completed output.
    } finally {
        session.dispose();
    }
});

test("canvas_update_storyboard reconciles row asset-to-script edges without leaking an old scene to another row", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=storyboard-row-asset-edges"), events.response as never);
    session.updateState({
        projectId: "canvas-storyboard-row-asset-edges",
        revision: 1,
        nodes: [
            { id: "script", type: "script", position: { x: 0, y: 0 }, width: 700, height: 400, metadata: { storyboard: { rows: [
                { id: "row-a", shotNumber: 1, durationSeconds: 6, plotDescription: "A", videoMotionPrompt: "A video", videoNodeId: "video-a", assetBindings: [{ nodeId: "character-a", role: "character" }, { nodeId: "scene-old", role: "environment" }] },
                { id: "row-b", shotNumber: 2, durationSeconds: 6, plotDescription: "B", videoMotionPrompt: "B video", videoNodeId: "video-b", assetBindings: [{ nodeId: "character-b", role: "character" }, { nodeId: "scene-b", role: "environment" }] },
            ], visibleColumns: [], referenceNodeIds: [] } } },
            { id: "character-a", type: "image", position: { x: 0, y: 500 }, width: 200, height: 150, metadata: { workflowKind: "character" } },
            { id: "scene-old", type: "image", position: { x: 250, y: 500 }, width: 200, height: 150, metadata: {} },
            { id: "scene-new", type: "image", position: { x: 500, y: 500 }, width: 200, height: 150, metadata: {} },
            { id: "character-b", type: "image", position: { x: 0, y: 800 }, width: 200, height: 150, metadata: { workflowKind: "character" } },
            { id: "scene-b", type: "image", position: { x: 250, y: 800 }, width: 200, height: 150, metadata: {} },
            { id: "video-a", type: "video", position: { x: 900, y: 0 }, width: 300, height: 200, metadata: { status: "idle" } },
            { id: "video-b", type: "video", position: { x: 900, y: 300 }, width: 300, height: 200, metadata: { status: "idle" } },
        ],
        connections: [
            { id: "a-script-old-scene", fromNodeId: "scene-old", toNodeId: "script", toHandleId: "row:row-a", relation: "storyboard-asset-reference", storyboardRowId: "row-a" },
            { id: "a-video-old-scene", fromNodeId: "scene-old", toNodeId: "video-a", relation: "storyboard-asset-reference", storyboardRowId: "row-a" },
            { id: "a-script-character", fromNodeId: "character-a", toNodeId: "script", toHandleId: "row:row-a", relation: "storyboard-asset-reference", storyboardRowId: "row-a" },
            { id: "a-video-character", fromNodeId: "character-a", toNodeId: "video-a", relation: "storyboard-asset-reference", storyboardRowId: "row-a" },
            { id: "a-output", fromNodeId: "script", toNodeId: "video-a", fromHandleId: "row:row-a", relation: "storyboard-output", storyboardRowId: "row-a" },
            { id: "b-script-scene", fromNodeId: "scene-b", toNodeId: "script", toHandleId: "row:row-b", relation: "storyboard-asset-reference", storyboardRowId: "row-b" },
            { id: "b-video-scene", fromNodeId: "scene-b", toNodeId: "video-b", relation: "storyboard-asset-reference", storyboardRowId: "row-b" },
            { id: "b-script-character", fromNodeId: "character-b", toNodeId: "script", toHandleId: "row:row-b", relation: "storyboard-asset-reference", storyboardRowId: "row-b" },
            { id: "b-video-character", fromNodeId: "character-b", toNodeId: "video-b", relation: "storyboard-asset-reference", storyboardRowId: "row-b" },
            { id: "b-output", fromNodeId: "script", toNodeId: "video-b", fromHandleId: "row:row-b", relation: "storyboard-output", storyboardRowId: "row-b" },
        ],
        viewport: { x: 0, y: 0, k: 1 },
    }, "storyboard-row-asset-edges");
    try {
        const before = await session.callTool("canvas_get_storyboard", { nodeId: "script" }) as { revision: number; stateHash: string };
        const pending = session.callTool("canvas_update_storyboard", {
            nodeId: "script", mode: "merge", expectedRevision: before.revision, expectedStateHash: before.stateHash,
            rows: [{ id: "row-a", assetBindings: [{ nodeId: "character-a", role: "character" }, { nodeId: "scene-new", role: "environment" }] }],
        });
        const call = latestToolCall(events.writes());
        const ops = (call.input as { ops: Array<Record<string, unknown>> }).ops;
        const deletedIds = ops.filter((op) => op.type === "delete_connections").flatMap((op) => op.ids as string[]);
        assert.deepEqual(deletedIds.sort(), ["a-script-old-scene", "a-video-character", "a-video-old-scene", "b-video-character", "b-video-scene"]);
        assert.ok(ops.some((op) => op.type === "connect_nodes" && op.fromNodeId === "scene-new" && op.toNodeId === "script" && op.toHandleId === "row:row-a" && op.storyboardRowId === "row-a"));
        assert.equal(ops.some((op) => op.type === "connect_nodes" && op.fromNodeId === "scene-new" && op.toNodeId === "video-a"), false);
        const pendingVideo = ops.find((op) => op.type === "update_node" && op.id === "video-a")!.metadata as Record<string, unknown>;
        assert.equal(String(pendingVideo.composerContent).includes("@[node:scene-new]"), true);
        assert.equal(String(pendingVideo.composerContent).includes("@[node:scene-old]"), false);
        assert.equal(ops.some((op) => op.type === "connect_nodes" && op.fromNodeId === "scene-old" && op.toNodeId === "video-b"), false);
        assert.equal(deletedIds.some((id) => id.startsWith("b-script") || id === "b-output"), false);
        session.resolveResult({ requestId: call.requestId, error: "fixture cleanup" }, "storyboard-row-asset-edges");
        await assert.rejects(pending, /fixture cleanup/);
    } finally {
        session.dispose();
    }
});

test("canvas_get_storyboard does not treat a ready video resource without a generation task as a complete row", async () => {
    const session = new FixtureCanvasSession();
    const snapshot: CanvasSnapshot = {
        projectId: "canvas-row-trace-missing",
        nodes: [
            { id: "script", type: "script", position: { x: 0, y: 0 }, width: 500, height: 300, metadata: { storyboard: { rows: [{ id: "row", shotNumber: 1, durationSeconds: 5, videoNodeId: "video", status: "success" }], visibleColumns: ["shotNumber"], referenceNodeIds: [] } } },
            { id: "video", type: "video", position: { x: 600, y: 0 }, width: 320, height: 240, metadata: { status: "success", resourceId: "video-resource", storageKey: "fixture/video.mp4" } },
        ],
        connections: [{ id: "row-video", fromNodeId: "script", toNodeId: "video", fromHandleId: "row:row", relation: "storyboard-output", storyboardRowId: "row" }],
        viewport: { x: 0, y: 0, k: 1 },
    };
    session.updateState(snapshot, "row-trace-missing");
    try {
        const result = await session.callTool("canvas_get_storyboard", { nodeId: "script" }) as { storyboards: Array<{ rows: Array<{ bindingState: { rowTrace: { traceConsistent: boolean; traceIssues: string[] } } }> }> };
        const trace = result.storyboards[0].rows[0].bindingState.rowTrace;
        assert.equal(trace.traceConsistent, false);
        assert.ok(trace.traceIssues.includes("video_task_missing"));
    } finally {
        session.dispose();
    }
});

test("canvas_get_storyboard flags segment task and resource claims that differ from the connected node", async () => {
    const session = new FixtureCanvasSession();
    const snapshot: CanvasSnapshot = {
        projectId: "canvas-trace-mismatch",
        nodes: [
            { id: "script", type: "script", position: { x: 0, y: 0 }, width: 500, height: 300, metadata: { storyboard: { rows: [{ id: "row", shotNumber: 1, durationSeconds: 10, videoNodeId: "video", segmentBindings: [{ segmentId: "seg-1", order: 0, videoNodeId: "video", taskId: "claimed-task", resourceId: "claimed-resource", stepId: "step-1", attemptId: "attempt-1", model: "minimax-h3", capabilityRevision: "minimax-h3:1", requestedDurationSeconds: 10, timelineStartMs: 0, timelineDurationMs: 10000, status: "succeeded" }] }], visibleColumns: ["shotNumber"], referenceNodeIds: [] } } },
            { id: "video", type: "video", position: { x: 600, y: 0 }, width: 320, height: 240, metadata: { status: "success", taskId: "actual-task", taskStatus: "succeeded", resourceId: "actual-resource", storageKey: "fixture/video.mp4", model: "minimax-h3" } },
        ],
        connections: [{ id: "row-video", fromNodeId: "script", toNodeId: "video", fromHandleId: "row:row", relation: "storyboard-output", storyboardRowId: "row" }],
        viewport: { x: 0, y: 0, k: 1 },
    };
    session.updateState(snapshot, "trace-mismatch");
    try {
        const result = await session.callTool("canvas_get_storyboard", { nodeId: "script" }) as { storyboards: Array<{ rows: Array<{ bindingState: { segments: Array<{ traceConsistent: boolean; traceIssues: string[] }> } }> }> };
        const trace = result.storyboards[0].rows[0].bindingState.segments[0];
        assert.equal(trace.traceConsistent, false);
        assert.ok(trace.traceIssues.includes("task_id_mismatch"));
        assert.ok(trace.traceIssues.includes("resource_id_mismatch"));
    } finally {
        session.dispose();
    }
});

test("canvas_get_storyboard traces a completed UI task segment without inventing a ProductionRun attempt", async () => {
    const session = new FixtureCanvasSession();
    const snapshot: CanvasSnapshot = {
        projectId: "canvas-ui-task-segment",
        nodes: [
            { id: "script", type: "script", position: { x: 0, y: 0 }, width: 500, height: 300, metadata: { storyboard: { rows: [{ id: "row-1", shotNumber: 1, durationSeconds: 5, videoNodeId: "merged-video", status: "success", segmentBindings: [{ segmentId: "row-1-segment-1", order: 0, videoNodeId: "generated-video", taskId: "ui-task-1", resourceId: "ui-resource-1", model: "CHANNEL_000002::minimax_h3_b99_003_12s", requestedDurationSeconds: 5, timelineStartMs: 0, timelineDurationMs: 5000, status: "succeeded" }] }], visibleColumns: ["shotNumber"], referenceNodeIds: [] } } },
            { id: "generated-video", type: "video", position: { x: 600, y: 0 }, width: 320, height: 180, metadata: { status: "success", taskId: "ui-task-1", taskStatus: "succeeded", resourceId: "ui-resource-1", storageKey: "resource:ui-resource-1", model: "CHANNEL_000002::minimax_h3_b99_003_12s" } },
            { id: "merged-video", type: "video", position: { x: 1000, y: 0 }, width: 320, height: 180, metadata: { status: "success", resourceId: "merge-resource", storageKey: "resource:merge-resource" } },
        ],
        connections: [
            { id: "row-output-generated", fromNodeId: "script", toNodeId: "generated-video", fromHandleId: "row:row-1", relation: "storyboard-output", storyboardRowId: "row-1" },
            { id: "row-output-merge", fromNodeId: "script", toNodeId: "merged-video", fromHandleId: "row:row-1", relation: "storyboard-output", storyboardRowId: "row-1" },
            { id: "generated-to-merge", fromNodeId: "generated-video", toNodeId: "merged-video" },
        ],
        viewport: { x: 0, y: 0, k: 1 },
    };
    session.updateState(snapshot, "ui-task-segment");
    try {
        const result = await session.callTool("canvas_get_storyboard", { nodeId: "script" }) as { storyboards: Array<{ rows: Array<{ bindingState: { rowTrace: { traceConsistent: boolean; traceIssues: string[] }; segments: Array<{ traceScope: string; traceConsistent: boolean; traceIssues: string[]; observedTaskId: string; observedResourceId: string }> } }> }> };
        const row = result.storyboards[0].rows[0];
        const segment = row.bindingState.segments[0];
        assert.equal(row.bindingState.rowTrace.traceConsistent, true);
        assert.deepEqual(row.bindingState.rowTrace.traceIssues, []);
        assert.equal(segment.traceScope, "canvas_task");
        assert.equal(segment.traceConsistent, true);
        assert.deepEqual(segment.traceIssues, []);
        assert.equal(segment.observedTaskId, "ui-task-1");
        assert.equal(segment.observedResourceId, "ui-resource-1");
    } finally {
        session.dispose();
    }
});

test("canvas_update_storyboard 写入真实分镜并保留超过 15 秒的叙事镜头", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=storyboard"), events.response as never);
    let snapshot: CanvasSnapshot = {
        nodes: [{ id: "script-1", type: "script", title: "分镜表", position: { x: 0, y: 0 }, width: 800, height: 400, metadata: { storyboard: { rows: [], visibleColumns: ["shotNumber"], referenceNodeIds: [] } } }],
        connections: [],
    };
    session.updateState(snapshot, "storyboard");
    try {
        const context = buildCanvasContext(snapshot);
        const pending = session.callTool("canvas_update_storyboard", {
            mode: "replace",
            expectedRevision: context.revision,
            expectedStateHash: context.stateHash,
            rows: [
                { shotNumber: 1, durationSeconds: 22, plotDescription: "开场", dialogue: "你好", voiceover: "旁白", imageGenerationPrompt: "首帧", videoMotionPrompt: "推镜", negativePrompt: "模糊" },
                { shotNumber: 2, durationSeconds: 8 },
            ],
        });
        const call = latestToolCall(events.writes());
        assert.equal(call.name, "canvas_apply_ops");
        const op = (call.input as { ops: Array<{ type: string; id: string; metadata: { storyboard: { rows: Array<Record<string, unknown>> } } }> }).ops[0];
        assert.equal(op.type, "update_node");
        assert.equal(op.id, "script-1");
        const rows = op.metadata.storyboard.rows;
        assert.equal(rows.length, 2);
        // 通过校验的字段原样落到真实 StoryboardRow。
        assert.equal(rows[0].durationSeconds, 22);
        assert.equal(rows[0].dialogue, "你好");
        assert.equal(rows[0].voiceover, "旁白");
        assert.equal(rows[0].imageGenerationPrompt, "首帧");
        assert.equal(rows[0].videoMotionPrompt, "推镜");
        assert.equal(rows[0].negativePrompt, "模糊");
        assert.equal(rows[1].durationSeconds, 8);
        assert.equal(rows[1].status, "idle");
        const applied = applyStoryboardOpsFixture(snapshot, call.input as { ops: Array<Record<string, unknown>> });
        session.resolveResult({ requestId: call.requestId, result: applied });
        const result = await pending as { readback: { storyboards: Array<{ rows: Array<Record<string, unknown>> }> } };
        assert.equal(result.readback.storyboards[0].rows[0].durationSeconds, 22);
    } finally {
        session.dispose();
    }
});

test("canvas_update_storyboard merge 按镜号合并、保留未传字段并保留叙事镜头时长", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=storyboard-merge"), events.response as never);
    let snapshot: CanvasSnapshot = {
        nodes: [{
            id: "script-1",
            type: "script",
            title: "分镜表",
            position: { x: 0, y: 0 },
            width: 800,
            height: 400,
            metadata: { storyboard: { rows: [{ id: "shot-1", shotNumber: 1, durationSeconds: 22, plotDescription: "原剧情", dialogue: "原对白" }, { id: "shot-2", shotNumber: 2, durationSeconds: 5, plotDescription: "第二镜", dialogue: "第二对白" }], visibleColumns: ["shotNumber"], referenceNodeIds: [] } },
        }],
        connections: [],
    };
    session.updateState(snapshot, "storyboard-merge");
    try {
        const context = buildCanvasContext(snapshot);
        const pending = session.callTool("canvas_update_storyboard", {
            mode: "merge",
            expectedRevision: context.revision,
            expectedStateHash: context.stateHash,
            rows: [
                { id: "shot-1", shotNumber: 1, plotDescription: "改后剧情" },
                { id: "shot-3", shotNumber: 3, durationSeconds: 12, plotDescription: "新增镜头" },
            ],
        });
        const call = latestToolCall(events.writes());
        const rows = (call.input as { ops: Array<{ metadata: { storyboard: { rows: Array<Record<string, unknown>> } } }> }).ops[0].metadata.storyboard.rows;
        assert.equal(rows.length, 3);
        // 同一镜号合并：只更新传入字段，未传的对白保留。
        assert.equal(rows[0].plotDescription, "改后剧情");
        assert.equal(rows[0].dialogue, "原对白");
        // 叙事镜头可超过单次模型上限，写入真实分镜时不得静默截短。
        assert.equal(rows[0].durationSeconds, 22);
        // 未触碰的镜头原样保留。
        assert.equal(rows[1].durationSeconds, 5);
        assert.equal(rows[1].dialogue, "第二对白");
        // 新镜号追加。
        assert.equal(rows[2].shotNumber, 3);
        assert.equal(rows[2].durationSeconds, 12);
        const applied = applyStoryboardOpsFixture(snapshot, call.input as { ops: Array<Record<string, unknown>> });
        session.resolveResult({ requestId: call.requestId, result: applied });
        await pending;
    } finally {
        session.dispose();
    }
});

test("canvas_merge_videos 只转发给已连接的衍图页面", async () => {
    const offline = new FixtureCanvasSession();
    await assert.rejects(offline.callTool("canvas_merge_videos", {
        videoNodeIds: ["v1", "v2"], expectedCanvasId: "offline-canvas", expectedRevision: 0, expectedStateHash: "offline-hash",
    }), /canvas_not_connected/);
    offline.dispose();

    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=merge"), events.response as never);
    session.updateState({ nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 } }, "merge");
    try {
        const pending = session.callTool("canvas_merge_videos", { videoNodeIds: ["v1", "v2"], title: "成片" });
        const call = latestToolCall(events.writes());
        assert.equal(call.name, "canvas_merge_videos");
        assert.deepEqual((call.input as { videoNodeIds: string[] }).videoNodeIds, ["v1", "v2"]);
        session.resolveResult({ requestId: call.requestId, result: { ok: true, videoNodeId: "final-1" } });
        assert.deepEqual(await pending, { ok: true, videoNodeId: "final-1" });
    } finally {
        session.dispose();
    }
});

test("30 秒测试短片端到端：分镜≤15 秒 → 逐镜生成 → 状态查询 → 最后合片", async () => {
    const session = new FixtureCanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=pipeline"), events.response as never);
    let snapshot: CanvasSnapshot = {
        projectId: "canvas-1",
        domainProjectId: "project-1",
        nodes: [{ id: "script-1", type: "script", title: "分镜表", position: { x: 0, y: 0 }, width: 900, height: 400, metadata: { storyboard: { rows: [], visibleColumns: ["shotNumber"], referenceNodeIds: [] } } }],
        connections: [],
        viewport: { x: 0, y: 0, k: 1 },
    };
    session.updateState(snapshot, "pipeline");

    const forwarded: string[] = [];
    const callAndApply = async (name: string, input: Record<string, unknown>) => {
        const context = buildCanvasContext(snapshot);
        const guardedInput = name === "canvas_update_storyboard" ? { ...input, expectedRevision: context.revision, expectedStateHash: context.stateHash } : input;
        const pending = session.callTool(name, guardedInput);
        const call = latestToolCall(events.writes());
        forwarded.push(call.name);
        const result = name === "canvas_update_storyboard"
            ? applyStoryboardOpsFixture(snapshot, call.input as { ops: Array<Record<string, unknown>> })
            : { applied: true };
        if (name === "canvas_update_storyboard" && "snapshot" in result) snapshot = result.snapshot;
        session.resolveResult({ requestId: call.requestId, result });
        return { call, value: await pending };
    };
    const runGenerationMode = (input: unknown) => {
        const ops = (input as { ops: Array<{ type: string; mode?: string }> }).ops;
        return ops.find((op) => op.type === "run_generation")?.mode;
    };

    try {
        // 1) 叙事镜头可以保留真实目标时长；单次模型请求的拆分属于后续 GenerationSegment。
        const storyboard = await callAndApply("canvas_update_storyboard", {
            mode: "replace",
            rows: [
                { shotNumber: 1, durationSeconds: 20, plotDescription: "开场", dialogue: "你好", imageGenerationPrompt: "首帧 1", videoMotionPrompt: "推镜" },
                { shotNumber: 2, durationSeconds: 10, plotDescription: "收尾", voiceover: "旁白", imageGenerationPrompt: "首帧 2", videoMotionPrompt: "拉镜" },
            ],
        });
        const rows = (storyboard.call.input as { ops: Array<{ metadata: { storyboard: { rows: Array<Record<string, unknown>> } } }> }).ops[0].metadata.storyboard.rows;
        assert.equal(rows.length, 2);
        const totalSeconds = rows.reduce((sum, row) => sum + Number(row.durationSeconds || 0), 0);
        assert.equal(totalSeconds, 30);
        // 3) 逐镜首帧（图片）→ 视频 → 音频，全部走页面现有生成链路。
        const image = await callAndApply("canvas_generate_image", { prompt: "首帧 1", title: "镜头 1 首帧" });
        assert.equal(runGenerationMode(image.call.input), "image");
        const video = await callAndApply("canvas_generate_video", { prompt: "推镜", title: "镜头 1 视频" });
        assert.equal(runGenerationMode(video.call.input), "video");
        const audio = await callAndApply("canvas_generate_audio", { prompt: "旁白", title: "镜头 1 旁白" });
        assert.equal(runGenerationMode(audio.call.input), "audio");

        // 4) 状态查询是本地读取，不应把任何写入发给页面。
        const before = forwarded.length;
        const tasks = await session.callTool("canvas_get_generation_tasks", {}) as { tasks: unknown[] };
        assert.ok(Array.isArray(tasks.tasks));
        assert.equal(forwarded.length, before);

        // 5) 所有镜头完成后才合片，且只调用一次页面同款合并链路。
        const merge = await callAndApply("canvas_merge_videos", { videoNodeIds: ["video-1", "video-2"], title: "测试短片成片" });
        assert.equal(merge.call.name, "canvas_merge_videos");

        assert.equal(forwarded[0], "canvas_apply_ops");
        assert.equal(forwarded.filter((name) => name === "canvas_merge_videos").length, 1);
        assert.equal(forwarded.at(-1), "canvas_merge_videos");
    } finally {
        session.dispose();
    }
});

test("runtime_diagnostics returns a build identity and never exposes the runtime token", async () => {
    const session = new FixtureCanvasSession();
    session.updateState({ projectId: "canvas-current", domainProjectId: "project-current", nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 } }, "diagnostic-client");
    try {
        const result = await session.callTool("runtime_diagnostics", {}) as { buildId: string; toolsetVersion: string; schemaVersion: number; binding: { canvasId: string }; runtime: { connected: boolean } };
        assert.match(result.buildId, /^sha256:[a-f0-9]{64}$/);
        assert.equal(result.toolsetVersion, "yingce-mcp-v3");
        assert.equal(result.schemaVersion, 3);
        assert.equal(result.binding.canvasId, "canvas-current");
        assert.equal(result.runtime.connected, false, "diagnostics reads canvas binding even before a page stream is connected");
        assert.equal(JSON.stringify(result).includes(token), false);
    } finally {
        session.dispose();
    }
});

test("removed built-in Agent routes return an explicit non-executing 410", async () => {
    const module = createCanvasAgentHttpModule(fixtureConfig(), sessionFixture([]));
    const manager = new LocalRuntimeSessionManager({ endpoint, trustedOrigins: [origin], registrations: [] });
    const app = createLocalRuntimeApp({ authority, endpoint, version: "0.1.0", sessionManager: manager, modules: [module], legacyMasterToken: token, legacyOrigins: [origin] });
    const server = app.listen(0, "127.0.0.1");
    await listening(server);
    try {
        for (const [method, path] of [["GET", "/agent/codex/workspace"], ["POST", "/agent/codex/turn"], ["POST", "/agent/claude/turn"]] as const) {
            const response = await request(server, { method, path: `${path}?token=${token}`, headers: jsonHeaders(), body: method === "POST" ? "{}" : undefined });
            assert.equal(response.status, 410);
            assert.match(response.body, /agent_control_removed/);
        }
    } finally {
        manager.dispose();
        await close(server);
    }
});
