import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { CanvasSession } from "../src/canvas-session.js";

type ContextRead = { revision: number; stateHash: string };

function eventResponse() {
    const writes: string[] = [];
    const response = new EventEmitter() as EventEmitter & {
        writeHead(): void;
        write(chunk: unknown): void;
        end(): void;
    };
    response.writeHead = () => undefined;
    response.write = (chunk) => { writes.push(String(chunk)); };
    response.end = () => undefined;
    return { response, writes: () => [...writes] };
}

function latestToolCall(writes: string[]) {
    const event = [...writes].reverse().find((value) => value.startsWith("event: tool_call\n"));
    assert.ok(event, "expected a tool_call event");
    const data = event.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(data, "expected tool_call payload");
    return JSON.parse(data.slice("data: ".length)) as { requestId: string; name: string; input: unknown };
}

async function readRevision(session: CanvasSession) {
    return await session.callTool("canvas_get_context", {}) as unknown as ContextRead & { canvas: { projectId: string } };
}

test("a reconnecting page cannot rewind the runtime canvas revision", async () => {
    const session = new CanvasSession();
    const first = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=page-1"), first.response as never);

    const initial = session.updateState({ projectId: "canvas-revision", nodes: [], revision: 7 }, "page-1");
    assert.equal(initial.accepted, true);
    assert.equal(initial.revision, 7);
    assert.equal((await readRevision(session)).revision, 7);

    // 工具结果写回会推进运行时 revision，即使页面自身计数没有变化。
    const beforeWrite = await readRevision(session);
    const pending = session.callTool("canvas_apply_ops", {
        expectedCanvasId: beforeWrite.canvas.projectId,
        expectedRevision: beforeWrite.revision,
        expectedStateHash: beforeWrite.stateHash,
        ops: [{ type: "select_nodes", ids: [] }],
    });
    const call = latestToolCall(first.writes());
    session.resolveResult({
        requestId: call.requestId,
        result: { ok: true, snapshot: { projectId: "canvas-revision", nodes: [], connections: [] } },
    }, "page-1");
    await pending;
    const bumped = await readRevision(session);
    assert.ok(bumped.revision > 7, `tool result must advance the revision, got ${bumped.revision}`);

    // 页面短暂断线会清空画布状态；重连后页面带着较小的自身计数同步时，运行时不能回退。
    first.response.emit("close");
    assert.deepEqual(session.health(), { ok: true, hasCanvas: false, clients: 0 });

    const second = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=page-1"), second.response as never);
    const resynced = session.updateState({ projectId: "canvas-revision", nodes: [], revision: 3 }, "page-1");
    assert.equal(resynced.accepted, true);
    assert.ok(
        resynced.revision > bumped.revision,
        `revision must stay monotonic across reconnect: floor=${bumped.revision} got=${resynced.revision}`,
    );
    assert.equal((await readRevision(session)).revision, resynced.revision);
    session.dispose();
});

test("a stale revision is still rejected while the canvas state is live", () => {
    const session = new CanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=page-2"), events.response as never);
    session.updateState({ projectId: "canvas-stale", nodes: [], revision: 5 }, "page-2");

    const rejected = session.updateState({ projectId: "canvas-stale", nodes: [], revision: 2 }, "page-2");
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, "stale_revision");
    session.dispose();
});

test("director frame capture requires the current canvas precondition before requesting the browser viewport", async () => {
    const session = new CanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=director-capture"), events.response as never);
    session.updateState({ projectId: "director-canvas", nodes: [], connections: [], revision: 4 }, "director-capture");
    const context = await readRevision(session);
    await assert.rejects(session.callTool("canvas_capture_director_frame", {
        expectedCanvasId: context.canvas.projectId,
        expectedRevision: context.revision - 1,
        expectedStateHash: context.stateHash,
        sceneId: "scene-1", shotId: "shot-1", expectedSceneHash: "scene-hash",
    }), /画布状态已变化/);
    const pending = session.callTool("canvas_capture_director_frame", {
        expectedCanvasId: context.canvas.projectId,
        expectedRevision: context.revision,
        expectedStateHash: context.stateHash,
        sceneId: "scene-1", shotId: "shot-1", expectedSceneHash: "scene-hash",
    });
    const call = latestToolCall(events.writes());
    assert.equal(call.name, "canvas_capture_director_frame");
    session.resolveResult({ requestId: call.requestId, result: { ok: true, nodeId: "image-1", resourceId: "resource-1" } }, "director-capture");
    assert.deepEqual(await pending, { ok: true, nodeId: "image-1", resourceId: "resource-1" });
    session.dispose();
});

test("director video capture validates duration and waits for the browser recording result", async () => {
    const session = new CanvasSession();
    const events = eventResponse();
    session.openEvents(new URL("http://127.0.0.1/events?clientId=director-video"), events.response as never);
    session.updateState({ projectId: "director-video-canvas", nodes: [], connections: [], revision: 2 }, "director-video");
    const context = await readRevision(session);
    const base = {
        expectedCanvasId: context.canvas.projectId,
        expectedRevision: context.revision,
        expectedStateHash: context.stateHash,
        sceneId: "scene-1", shotId: "shot-1", expectedSceneHash: "scene-hash",
    };
    await assert.rejects(session.callTool("canvas_capture_director_video", { ...base, durationSeconds: 30.1 }));
    const pending = session.callTool("canvas_capture_director_video", { ...base, durationSeconds: 1.25 });
    const call = latestToolCall(events.writes());
    assert.equal(call.name, "canvas_capture_director_video");
    session.resolveResult({ requestId: call.requestId, result: { ok: true, videoNodeId: "video-1", resourceId: "resource-1" } }, "director-video");
    assert.deepEqual(await pending, { ok: true, videoNodeId: "video-1", resourceId: "resource-1" });
    session.dispose();
});
