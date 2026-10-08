import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { CanvasSession } from "../src/canvas-session.js";
import { buildCanvasContext } from "../src/canvas-context.js";
import { toolInputSchemas } from "../src/schemas.js";

function eventResponse() {
    const writes: string[] = [];
    const response = new EventEmitter() as EventEmitter & { writeHead(): void; write(chunk: unknown): void; end(): void };
    response.writeHead = () => undefined;
    response.write = (chunk) => { writes.push(String(chunk)); };
    response.end = () => undefined;
    return { response, writes };
}

function latestToolCall(writes: string[]) {
    const event = [...writes].reverse().find((value) => value.startsWith("event: tool_call\n"));
    assert.ok(event, "expected a tool_call event");
    const data = event.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(data);
    return JSON.parse(data.slice("data: ".length)) as { requestId: string; name: string; input: Record<string, unknown> };
}

function fixture(projectId: string, nodeId: string, revision = 0) {
    return {
        projectId,
        nodes: [{ id: nodeId, type: "text", title: nodeId, position: { x: 0, y: 0 }, width: 100, height: 80, metadata: { content: nodeId } }],
        connections: [],
        viewport: { x: 0, y: 0, k: 1 },
        revision,
    };
}

function connect(session: CanvasSession, clientId: string, projectId: string, runtimeSessionId = `runtime-${clientId}`) {
    const events = eventResponse();
    session.openEvents(new URL(`http://127.0.0.1/events?clientId=${clientId}`), events.response as never, runtimeSessionId);
    const result = session.updateState(fixture(projectId, `node-${clientId}`), clientId);
    assert.equal(result.accepted, true);
    return events;
}

test("isolates simultaneous canvas state, revisions, reads, and writes by client", async () => {
    const session = new CanvasSession();
    const a = connect(session, "client-a", "canvas-a");
    const b = connect(session, "client-b", "canvas-b");
    try {
        assert.equal((session.updateState(fixture("canvas-a", "node-client-a", 1), "client-a")).revision, 1);
        assert.equal((session.updateState(fixture("canvas-b", "node-client-b", 1), "client-b")).revision, 1);

        const aState = await session.callTool("canvas_get_state", { canvasId: "canvas-a" }) as { projectId: string; nodes: Array<{ id: string }> };
        const bState = await session.callTool("canvas_get_state", { canvasId: "canvas-b" }) as { projectId: string; nodes: Array<{ id: string }> };
        assert.equal(aState.projectId, "canvas-a");
        assert.deepEqual(aState.nodes.map((node) => node.id), ["node-client-a"]);
        assert.equal(bState.projectId, "canvas-b");
        assert.deepEqual(bState.nodes.map((node) => node.id), ["node-client-b"]);
        await assert.rejects(session.callTool("canvas_get_state", {}), /ambiguous_canvas/);

        const aContext = await session.callTool("canvas_get_context", { canvasId: "canvas-a" }) as { revision: number; stateHash: string };
        const bContext = await session.callTool("canvas_get_context", { canvasId: "canvas-b" }) as { revision: number; stateHash: string };
        const beforeA = { ...aContext };
        const staleCrossCanvas = session.callTool("canvas_apply_ops", {
            expectedCanvasId: "canvas-b", expectedRevision: aContext.revision, expectedStateHash: aContext.stateHash,
            ops: [{ type: "select_nodes", ids: [] }],
        });
        await assert.rejects(staleCrossCanvas, /画布状态已变化|画布 revision/);
        assert.equal(b.writes.some((value) => value.startsWith("event: tool_call\n")), false);

        const pending = session.callTool("canvas_apply_ops", {
            expectedCanvasId: "canvas-b", expectedRevision: bContext.revision, expectedStateHash: bContext.stateHash,
            ops: [{ type: "select_nodes", ids: ["node-client-b"] }],
        });
        const call = latestToolCall(b.writes);
        assert.equal(a.writes.some((value) => value.startsWith("event: tool_call\n")), false);
        session.resolveResult({ requestId: call.requestId, result: { ok: true, snapshot: fixture("canvas-b", "node-client-b", 0) } }, "client-b");
        await pending;
        const afterA = await session.callTool("canvas_get_context", { canvasId: "canvas-a" }) as { revision: number; stateHash: string };
        assert.deepEqual(afterA, beforeA);
    } finally {
        session.dispose();
    }
});

test("rejects writes when the same canvas is open in two client tabs", async () => {
    const session = new CanvasSession();
    connect(session, "same-a", "same-canvas");
    connect(session, "same-b", "same-canvas");
    try {
        await assert.rejects(session.callTool("canvas_apply_ops", {
            expectedCanvasId: "same-canvas", expectedRevision: 0, expectedStateHash: "whatever", ops: [],
        }), /same_canvas_multiple_clients/);
        await assert.rejects(session.callTool("canvas_get_context", { canvasId: "same-canvas" }), /ambiguous_canvas_client/);
        const selected = await session.callTool("canvas_get_context", { canvasId: "same-canvas", clientId: "same-b" }) as { revision: number; stateHash: string };
        const expected = buildCanvasContext(fixture("same-canvas", "node-same-b", 1));
        assert.equal(selected.stateHash, expected.stateHash);
    } finally {
        session.dispose();
    }
});

test("routes node render inspection as a read using canvasId without write preconditions", async () => {
    const session = new CanvasSession();
    const a = connect(session, "render-a", "canvas-a");
    const b = connect(session, "render-b", "canvas-b");
    try {
        const pending = session.callTool("canvas_inspect_node_render", { canvasId: "canvas-b", nodeId: "node-render-b" });
        const call = latestToolCall(b.writes);
        assert.equal(call.name, "canvas_inspect_node_render");
        assert.deepEqual(call.input, { canvasId: "canvas-b", nodeId: "node-render-b" });
        assert.equal(a.writes.some((value) => value.startsWith("event: tool_call\n")), false);
        session.resolveResult({ requestId: call.requestId, result: { nodeId: "node-render-b", visible: true } }, "render-b");
        assert.deepEqual(await pending, { nodeId: "node-render-b", visible: true });
    } finally {
        session.dispose();
    }
});

test("binds uploads to the selected client and canvas and rechecks its fence after staging", async () => {
    const session = new CanvasSession();
    const a = connect(session, "upload-a", "canvas-a");
    const b = connect(session, "upload-b", "canvas-b");
    const bindings: Array<{ clientId: string; runtimeSessionId: string; canvasId: string }> = [];
    let releaseCreate: (() => void) | undefined;
    const originalTransfers = (session as unknown as { localFileTransfers: unknown }).localFileTransfers;
    (session as unknown as { localFileTransfers: unknown }).localFileTransfers = {
        create: async (_filePath: string, binding: { clientId: string; runtimeSessionId: string; canvasId: string }) => {
            bindings.push(binding);
            await new Promise<void>((resolve) => { releaseCreate = resolve; });
            return { uploadId: "upload-binary", fileName: "input.txt", mimeType: "text/plain", size: 5, sha256: "hash" };
        },
        discard: () => undefined,
        dispose: () => undefined,
    };
    try {
        const contextB = await session.callTool("canvas_get_context", { canvasId: "canvas-b" }) as { revision: number; stateHash: string };
        const upload = session.callTool("canvas_upload_file", { filePath: "C:\\qa\\input.txt", expectedCanvasId: "canvas-b", expectedRevision: contextB.revision, expectedStateHash: contextB.stateHash });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(bindings, [{ clientId: "upload-b", runtimeSessionId: "runtime-upload-b", canvasId: "canvas-b" }]);
        session.updateState(fixture("canvas-b", "node-upload-b", contextB.revision + 1), "upload-b");
        releaseCreate?.();
        await assert.rejects(upload, /画布状态已变化/);
        assert.equal(b.writes.some((value) => value.startsWith("event: tool_call\n")), false);
        assert.equal(a.writes.some((value) => value.startsWith("event: tool_call\n")), false);
    } finally {
        (session as unknown as { localFileTransfers: unknown }).localFileTransfers = originalTransfers;
        session.dispose();
    }
});

test("routes available-asset lookup to the selected page without leaking media URLs", async () => {
    const session = new CanvasSession();
    const a = connect(session, "assets-a", "canvas-a");
    const b = connect(session, "assets-b", "canvas-b");
    try {
        const pending = session.callTool("canvas_find_available_assets", {
            canvasId: "canvas-b", query: "forest", kind: "image", limit: 12,
        });
        const call = latestToolCall(b.writes);
        assert.equal(call.name, "canvas_find_available_assets");
        assert.deepEqual(call.input, { canvasId: "canvas-b", query: "forest", kind: "image", limit: 12 });
        assert.equal(a.writes.some((value) => value.startsWith("event: tool_call\n")), false);
        session.resolveResult({ requestId: call.requestId, result: { items: [{ id: "asset-1", title: "Forest" }] } }, "assets-b");
        assert.deepEqual(await pending, { items: [{ id: "asset-1", title: "Forest" }] });
    } finally {
        session.dispose();
    }
});

test("disconnecting a pending client never falls back to another canvas", async () => {
    const session = new CanvasSession();
    const a = connect(session, "pending-a", "canvas-a");
    const b = connect(session, "pending-b", "canvas-b");
    try {
        const pending = session.callTool("canvas_find_available_assets", { canvasId: "canvas-b", query: "lake" });
        const call = latestToolCall(b.writes);
        b.response.emit("close");
        await assert.rejects(pending, /画布连接已断开/);
        session.resolveResult({ requestId: call.requestId, result: { items: [] } }, "pending-b");
        assert.equal(a.writes.some((value) => value.startsWith("event: tool_call\n")), false);
        const contextA = await session.callTool("canvas_get_context", { canvasId: "canvas-a" }) as { canvas: { projectId: string } };
        assert.equal(contextA.canvas.projectId, "canvas-a");
    } finally {
        session.dispose();
    }
});

test("lists canvas selectors locally and routes skills and projects without choosing the first tab", async () => {
    const session = new CanvasSession();
    const a = connect(session, "select-a", "canvas-a");
    const b = connect(session, "select-b", "canvas-b");
    try {
        const open = await session.callTool("canvas_list_open_canvases", {}) as Array<{ canvasId: string; clientId: string; revision: number; stateHash: string }>;
        assert.deepEqual(open.map(({ canvasId, clientId }) => [canvasId, clientId]), [["canvas-a", "select-a"], ["canvas-b", "select-b"]]);
        assert.ok(open.every((entry) => entry.stateHash.length > 0));
        assert.ok(open.every((entry) => !("nodes" in entry)));
        const capabilities = await session.callTool("canvas_get_capabilities", {}) as { tools: Array<{ name: string }> };
        assert.ok(capabilities.tools.length > 0);

        const ambiguousSkill = session.callTool("skill_catalog", {});
        await assert.rejects(ambiguousSkill, /ambiguous_canvas/);
        const skill = session.callTool("skill_catalog", { canvasId: "canvas-b" });
        const skillCall = latestToolCall(b.writes);
        assert.equal(skillCall.name, "skill_catalog");
        session.resolveResult({ requestId: skillCall.requestId, result: { skills: [] } }, "select-b");
        await skill;

        const unrelatedProject = session.callTool("project_get_context", { projectId: "project-not-linked-to-canvas-a" });
        await assert.rejects(unrelatedProject, /ambiguous_project_canvas/);
        const selectedProject = session.callTool("project_get_context", { projectId: "project-not-linked-to-canvas-a", canvasId: "canvas-b" });
        const projectCall = latestToolCall(b.writes);
        assert.equal(projectCall.name, "project_get_context");
        assert.equal(projectCall.input.projectId, "project-not-linked-to-canvas-a");
        session.resolveResult({ requestId: projectCall.requestId, result: { projectId: "project-not-linked-to-canvas-a" } }, "select-b");
        await selectedProject;
    } finally {
        session.dispose();
    }
});

test("resolveResult requires the originating client id", async () => {
    const session = new CanvasSession();
    const events = connect(session, "result-owner", "result-canvas");
    try {
        const pending = session.callTool("canvas_find_available_assets", { canvasId: "result-canvas" });
        const call = latestToolCall(events.writes);
        assert.equal(session.resolveResult({ requestId: call.requestId, result: { items: [] } }, "other-client"), false);
        assert.equal(session.resolveResult({ requestId: call.requestId, result: { items: [] } }, ""), false);
        session.resolveResult({ requestId: call.requestId, result: { items: [] } }, "result-owner");
        await pending;
    } finally {
        session.dispose();
    }
});

test("a single live page may access another project but writes never route without its state", async () => {
    const session = new CanvasSession();
    const events = connect(session, "single-project-client", "canvas-one");
    try {
        const context = session.callTool("project_get_context", { projectId: "accessible-project" });
        const call = latestToolCall(events.writes);
        assert.equal(call.name, "project_get_context");
        assert.equal(call.input.projectId, "accessible-project");
        session.resolveResult({ requestId: call.requestId, result: { projectId: "accessible-project" } }, "single-project-client");
        await context;
    } finally {
        session.dispose();
    }

    const noState = new CanvasSession();
    const emptyEvents = eventResponse();
    noState.openEvents(new URL("http://127.0.0.1/events?clientId=empty-client"), emptyEvents.response as never);
    try {
        await assert.rejects(noState.callTool("project_confirm_asset_candidate", {
            projectId: "accessible-project", candidateId: "candidate-1",
        }), /canvas_state_required/);
        assert.equal(emptyEvents.writes.some((value) => value.startsWith("event: tool_call\n")), false);
    } finally {
        noState.dispose();
    }
});

test("routes script bootstrap through one no-state home client and rejects ambiguous or unrelated tools", async () => {
    const session = new CanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=home-client"), events.response as never);
    try {
        const bootstrap = session.callTool("project_create_from_script", {
            title: "试拍短剧", script: "第一场：雨夜。", clientOperationId: "bootstrap-test-1", aspectRatio: "16:9",
        });
        const call = latestToolCall(events.writes);
        assert.equal(call.name, "project_create_from_script");
        assert.equal(call.input.aspectRatio, "16:9");
        session.resolveResult({ requestId: call.requestId, result: { projectId: "project-test" } }, "home-client");
        await bootstrap;
        await assert.rejects(session.callTool("project_get_context", { projectId: "project-test" }), /canvas_state_required/);
        assert.equal(toolInputSchemas.project_create_from_script.safeParse({
            title: "短剧", script: "剧本", clientOperationId: "op-1", canvasId: "canvas-a", clientId: "home-client", aspectRatio: "16:9",
        }).success, true);
        assert.equal(toolInputSchemas.project_create_from_script.safeParse({
            title: "短剧", script: "剧本", clientOperationId: "op-1", aspectRatio: "4:3",
        }).success, false);
    } finally {
        session.dispose();
    }

    const ambiguous = new CanvasSession();
    const first = eventResponse();
    const second = eventResponse();
    ambiguous.openEvents(new URL("http://127.0.0.1/events?clientId=home-a"), first.response as never);
    ambiguous.openEvents(new URL("http://127.0.0.1/events?clientId=home-b"), second.response as never);
    try {
        await assert.rejects(ambiguous.callTool("project_create_from_script", {
            title: "短剧", script: "剧本", clientOperationId: "op-ambiguous",
        }), /ambiguous_client/);
        assert.equal(first.writes.some((value) => value.startsWith("event: tool_call\n")), false);
        assert.equal(second.writes.some((value) => value.startsWith("event: tool_call\n")), false);
    } finally {
        ambiguous.dispose();
    }
});

test("registers storyboard media preflight and paid generation as distinct page tools", async () => {
    assert.equal(toolInputSchemas.canvas_preflight_storyboard_media.safeParse({
        canvasId: "canvas-story", nodeId: "script-1", kind: "image", rowIds: ["row-1"],
    }).success, true);
    assert.equal(toolInputSchemas.canvas_generate_storyboard_media.safeParse({
        expectedCanvasId: "canvas-story", expectedRevision: 0, expectedStateHash: "hash",
        nodeId: "script-1", kind: "video", rowIds: ["row-1"], clientOperationId: "stable-op-1",
    }).success, true);
    assert.equal(toolInputSchemas.canvas_generate_storyboard_media.safeParse({
        nodeId: "script-1", kind: "video", rowIds: ["row-1"], clientOperationId: "stable-op-1",
    }).success, false);

    const session = new CanvasSession();
    const events = connect(session, "story-media-client", "canvas-story");
    try {
        const preflight = session.callTool("canvas_preflight_storyboard_media", {
            canvasId: "canvas-story", nodeId: "script-1", kind: "image", rowIds: ["row-1"],
        });
        const preflightCall = latestToolCall(events.writes);
        assert.equal(preflightCall.name, "canvas_preflight_storyboard_media");
        session.resolveResult({ requestId: preflightCall.requestId, result: { ready: true, rows: [] } }, "story-media-client");
        await preflight;

        const context = await session.callTool("canvas_get_context", { canvasId: "canvas-story" }) as { revision: number; stateHash: string };
        const generation = session.callTool("canvas_generate_storyboard_media", {
            expectedCanvasId: "canvas-story", expectedRevision: context.revision, expectedStateHash: context.stateHash,
            nodeId: "script-1", kind: "video", rowIds: ["row-1"], clientOperationId: "stable-op-1",
        });
        const generationCall = latestToolCall(events.writes);
        assert.equal(generationCall.name, "canvas_generate_storyboard_media");
        assert.notEqual(generationCall.name, "canvas_apply_ops");
        session.resolveResult({ requestId: generationCall.requestId, result: { clientOperationId: "stable-op-1", status: "pending" } }, "story-media-client");
        await generation;
    } finally {
        session.dispose();
    }
});

test("registers batch-table row preflight and paid generation with scoped routing and state fences", async () => {
    assert.equal(toolInputSchemas.canvas_preflight_batch_rows.safeParse({
        canvasId: "batch-canvas-a", nodeId: "table-a", rowIds: ["row-1"],
    }).success, true);
    assert.equal(toolInputSchemas.canvas_preflight_batch_rows.safeParse({
        canvasId: "batch-canvas-a", nodeId: "table-a", rowIds: [],
    }).success, false);
    assert.equal(toolInputSchemas.canvas_generate_batch_rows.safeParse({
        expectedCanvasId: "batch-canvas-a", expectedRevision: 0, expectedStateHash: "hash",
        nodeId: "table-a", rowIds: ["row-1"], clientOperationId: "stable-batch-op-1",
    }).success, true);
    assert.equal(toolInputSchemas.canvas_generate_batch_rows.safeParse({
        nodeId: "table-a", rowIds: ["row-1"], clientOperationId: "stable-batch-op-1",
    }).success, false);

    const session = new CanvasSession();
    const a = connect(session, "batch-a", "batch-canvas-a");
    const b = connect(session, "batch-b", "batch-canvas-b");
    try {
        await assert.rejects(session.callTool("canvas_preflight_batch_rows", { nodeId: "table-a", rowIds: ["row-1"] }), /ambiguous_canvas/);
        const preflight = session.callTool("canvas_preflight_batch_rows", {
            canvasId: "batch-canvas-b", nodeId: "table-b", rowIds: ["row-1", "row-2"],
        });
        const preflightCall = latestToolCall(b.writes);
        assert.equal(preflightCall.name, "canvas_preflight_batch_rows");
        assert.deepEqual(preflightCall.input.rowIds, ["row-1", "row-2"]);
        assert.equal(a.writes.some((value) => value.startsWith("event: tool_call\n")), false);
        session.resolveResult({ requestId: preflightCall.requestId, result: { ready: true, rows: [] } }, "batch-b");
        await preflight;

        const sameOperationId = "same-id-isolated-by-the-selected-canvas";
        const contextA = await session.callTool("canvas_get_context", { canvasId: "batch-canvas-a" }) as { revision: number; stateHash: string };
        const generationA = session.callTool("canvas_generate_batch_rows", {
            expectedCanvasId: "batch-canvas-a", expectedRevision: contextA.revision, expectedStateHash: contextA.stateHash,
            nodeId: "table-a", rowIds: ["row-1"], clientOperationId: sameOperationId,
        });
        const callA = latestToolCall(a.writes);
        assert.equal(callA.name, "canvas_generate_batch_rows");
        assert.equal(callA.input.clientOperationId, sameOperationId);
        assert.notEqual(callA.name, "canvas_apply_ops");
        session.resolveResult({ requestId: callA.requestId, result: { clientOperationId: sameOperationId, status: "pending" } }, "batch-a");
        await generationA;

        const contextB = await session.callTool("canvas_get_context", { canvasId: "batch-canvas-b" }) as { revision: number; stateHash: string };
        const generationB = session.callTool("canvas_generate_batch_rows", {
            expectedCanvasId: "batch-canvas-b", expectedRevision: contextB.revision, expectedStateHash: contextB.stateHash,
            nodeId: "table-b", rowIds: ["row-1"], clientOperationId: sameOperationId,
        });
        const callB = latestToolCall(b.writes);
        assert.equal(callB.name, "canvas_generate_batch_rows");
        assert.equal(callB.input.clientOperationId, sameOperationId);
        session.resolveResult({ requestId: callB.requestId, result: { clientOperationId: sameOperationId, status: "pending" } }, "batch-b");
        await generationB;

        await assert.rejects(session.callTool("canvas_generate_batch_rows", {
            expectedCanvasId: "batch-canvas-b", expectedRevision: contextA.revision, expectedStateHash: contextA.stateHash,
            nodeId: "table-b", rowIds: ["row-1"], clientOperationId: "stale-cross-canvas-op",
        }), /画布状态已变化/);
    } finally {
        session.dispose();
    }
});

test("routes explicit reference edits through the native page tool behind canvas state fences", async () => {
    assert.equal(toolInputSchemas.canvas_edit_reference.safeParse({
        expectedCanvasId: "reference-canvas", expectedRevision: 0, expectedStateHash: "hash",
        operation: "add", targetNodeId: "target", sourceNodeId: "source",
    }).success, true);
    assert.equal(toolInputSchemas.canvas_edit_reference.safeParse({
        operation: "add", targetNodeId: "target", sourceNodeId: "source",
    }).success, false);
    assert.equal(toolInputSchemas.canvas_edit_reference.safeParse({
        expectedCanvasId: "reference-canvas", expectedRevision: 0, expectedStateHash: "hash",
        operation: "erase", targetNodeId: "target",
    }).success, false);

    const session = new CanvasSession();
    const a = connect(session, "reference-a", "reference-canvas-a");
    const b = connect(session, "reference-b", "reference-canvas-b");
    try {
        const context = await session.callTool("canvas_get_context", { canvasId: "reference-canvas-b" }) as { revision: number; stateHash: string };
        await assert.rejects(session.callTool("canvas_edit_reference", {
            expectedCanvasId: "reference-canvas-b", expectedRevision: context.revision, expectedStateHash: context.stateHash,
            operation: "add", targetNodeId: "target-b",
        }), /缺少 sourceNodeId/);
        assert.equal(b.writes.some((value) => value.startsWith("event: tool_call\n")), false);

        const add = session.callTool("canvas_edit_reference", {
            expectedCanvasId: "reference-canvas-b", expectedRevision: context.revision, expectedStateHash: context.stateHash,
            operation: "add", targetNodeId: "target-b", sourceNodeId: "source-b",
        });
        const addCall = latestToolCall(b.writes);
        assert.equal(addCall.name, "canvas_edit_reference");
        assert.equal(addCall.input.operation, "add");
        assert.equal(addCall.input.sourceNodeId, "source-b");
        assert.equal("connectionId" in addCall.input, false, "the webpage generates the connection ID");
        session.resolveResult({ requestId: addCall.requestId, result: { operation: "add", targetNodeId: "target-b", sourceNodeId: "source-b", references: [] } }, "reference-b");
        await add;

        const pending = session.callTool("canvas_edit_reference", {
            expectedCanvasId: "reference-canvas-b", expectedRevision: context.revision, expectedStateHash: context.stateHash,
            operation: "replace", targetNodeId: "target-b", sourceNodeId: "new-source", oldSourceNodeId: "old-source",
        });
        const call = latestToolCall(b.writes);
        assert.equal(call.name, "canvas_edit_reference");
        assert.equal(call.input.operation, "replace");
        assert.equal(call.input.targetNodeId, "target-b");
        assert.equal(call.input.expectedCanvasId, "reference-canvas-b");
        assert.notEqual(call.name, "canvas_apply_ops");
        assert.equal(a.writes.some((value) => value.startsWith("event: tool_call\n")), false);
        session.resolveResult({ requestId: call.requestId, result: { operation: "replace", targetNodeId: "target-b", sourceNodeId: "new-source", references: [] } }, "reference-b");
        await pending;

        await assert.rejects(session.callTool("canvas_edit_reference", {
            expectedCanvasId: "reference-canvas-b", expectedRevision: context.revision, expectedStateHash: "stale-reference-hash",
            operation: "remove", targetNodeId: "target-b", sourceNodeId: "source-b",
        }), /画布状态已变化/);
        assert.equal(b.writes.filter((value) => value.startsWith("event: tool_call\n")).length, 2, "stale state must be rejected before page dispatch");
    } finally {
        session.dispose();
    }
});
