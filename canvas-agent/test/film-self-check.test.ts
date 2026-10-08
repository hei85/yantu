import assert from "node:assert/strict";
import { test } from "node:test";
import { auditFilmWorkflow, readQualityPluginReports } from "../src/film-self-check.js";
import { toolInputSchemas, toolNames } from "../src/schemas.js";

const canvas = { projectId: "canvas-a", revision: 1, nodes: [{ id: "video", type: "video", position: { x: 0, y: 0 }, width: 400, height: 225, metadata: { storageKey: "resource:actual-video" } }], connections: [] };
const probe = async () => ({ok: true, probe: {decoded: true, durationMs: 1000, audioStreams: 1, width: 1280, height: 720}});
const run = (status: string, stepRevision = 2) => ({ id: "run", canvasId: "canvas-a", steps: [{stepKey: "quality:shot:1", kind: "check", status, revision: 2}], quality: {stepResults: {"quality:shot:1": {stepRevision, status: status === "succeeded" ? "passed" : status, evidence: {resourceId: "actual-video", semanticQuality: {status: "passed"}}}}} });
test("technical decode does not certify content or audio", async () => {
    const r = await auditFilmWorkflow(canvas, {}, {readRun: async () => ({}), probe});
    assert.equal(r.readyForDelivery, false); assert.equal(r.summary.uncertain, 1);
    assert.equal(r.mediaReports[0].checks[0].status, "passed");
    assert.equal(r.mediaReports[0].checks[1].status, "uncertain");
});
test("failed content is not promoted by a successful task or decode", async () => {
    const r = await auditFilmWorkflow(canvas, {runId: "run"}, {readRun: async () => run("failed"), probe});
    assert.equal(r.status, "failed"); assert.equal(r.readyForDelivery, false);
});
test("older evidence revisions are not reused", async () => {
    const r = await auditFilmWorkflow(canvas, {runId: "run"}, {readRun: async () => run("succeeded", 1), probe});
    assert.equal(r.mediaReports[0].checks[1].status, "uncertain");
});
test("a legacy blanket pass without observations remains uncertain", async () => {
    const r = await auditFilmWorkflow(canvas, {runId: "run"}, {readRun: async () => run("succeeded"), probe});
    assert.equal(r.mediaReports[0].checks[1].status, "uncertain");
});
test("listening evidence is read from the exact reviewed resource", async () => {
    const current = run("succeeded"); current.steps[0].inputFingerprint = "fp";
    const e = current.quality.stepResults["quality:shot:1"].evidence;
    Object.assign(e, {inputFingerprint:"fp", semanticQuality:{status:"passed",model:"reviewer",summary:"实际动作已查"}, reviewedMedia:[{resourceId:"actual-video",checks:[{name:"identity_anatomy",status:"passed",observation:"实际人物无复制"}],audioReview:{listeningStatus:"performed",voiceQuality:"passed",evaluator:"audio-reviewer",summary:"已听原音轨完整对白"}}]});
    const r = await auditFilmWorkflow(canvas, {runId:"run"},{readRun:async()=>current,probe});
    assert.equal(r.mediaReports[0].checks[1].status,"passed");assert.equal(r.mediaReports[0].checks[2].status,"passed");
});
test("wrong canvas binding is rejected", async () => {
    await assert.rejects(auditFilmWorkflow(canvas, {runId: "run"}, {readRun: async () => ({...run("succeeded"),canvasId:"other"}), probe}), /不一致/);
});
test("resource limit reports omissions and never probes extra resources", async () => {
    let calls = 0; const r = await auditFilmWorkflow(canvas, {resourceLimit: 0}, {readRun: async () => ({}), probe: async()=>{calls++;return {};}});
    assert.equal(calls, 0); assert.deepEqual(r.omittedResourceIds, ["actual-video"]); assert.equal(r.readyForDelivery,false);
});
test("local image caching is not mistaken for server media availability", async () => {
    const local = {...canvas, nodes: [{...canvas.nodes[0],type:"image",metadata:{storageKey:"local-image"}}]};
    const r = await auditFilmWorkflow(local, {}, {readRun:async()=>({}),probe});
    assert.equal(r.mediaReports[0].resourceId, "");assert.equal(r.mediaReports[0].status,"uncertain");
});
test("art report is exposed as stale when the source has changed", () => {
    const report = { ...canvas, nodes: [...canvas.nodes,{id:"art",type:"ai-art-critique",position:{x:0,y:0},width:1,height:1,metadata:{artCritique:{status:"completed",report:{sourceFingerprint:"old",summary:"No issues",issues:[]}}}}], connections:[{id:"edge",fromNodeId:"video",toNodeId:"art"}] };
    const r = readQualityPluginReports(report);assert.equal(r[0].status,"stale");assert.equal(r[0].reportAvailable,false);assert.equal(r[0].productionPass,false);
});
test("new tools are registered and selectors do not acquire write preconditions", () => {
    assert.ok(toolNames.includes("film_self_check"));assert.ok(toolNames.includes("canvas_read_quality_reports"));
    assert.equal(toolInputSchemas.film_self_check.safeParse({runId:"run",canvasId:"canvas-a"}).success,true);
    assert.equal(toolInputSchemas.canvas_read_quality_reports.safeParse({canvasId:"canvas-a"}).success,true);
    assert.equal(toolInputSchemas.film_self_check.safeParse({resourceLimit:121}).success,false);
    assert.equal(toolInputSchemas.film_self_check.safeParse({nodeIds:[]}).success,false);
});
