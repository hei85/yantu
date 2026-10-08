import assert from "node:assert/strict";
import { test } from "node:test";

import { toolInputSchemas } from "../src/schemas.js";

function reference(artifactId: string) {
    return { artifactId, versionId: "version-1", inputFingerprint: "input-hash", outputFingerprint: "output-hash" };
}

function request() {
    return {
        clientKey: "schema-test-only",
        plan: {
            productionSpec: {
                version: 1,
                workflowVersion: 2,
                preproduction: {
                    sourceScript: reference("script"),
                    brief: reference("brief"),
                    scriptBreakdown: reference("breakdown"),
                    visualDesign: reference("design"),
                    roughStoryboard: { ...reference("rough"), rowIds: ["row-1"] },
                    assetPackage: { ...reference("asset-needs"), assetIds: [] },
                    soundPlan: { ...reference("sound-plan"), voiceVersionIds: [] },
                    lockedStoryboard: { ...reference("locked"), rowIds: ["row-1"], durationFrames: 60 },
                    pilot: { ...reference("pilot-plan"), sampleRowIds: ["row-1"] },
                },
            },
        },
    };
}

test("MCP new whole-film runs require the versioned production workflow", () => {
    const valid = request();
    assert.deepEqual(toolInputSchemas.film_create_run.parse(valid), valid);
    assert.equal(toolInputSchemas.film_create_run.safeParse({ clientKey: valid.clientKey }).success, false);
    assert.equal(toolInputSchemas.film_create_run.safeParse({ ...valid, plan: { productionSpec: { version: 1, workflowVersion: 1 } } }).success, false);
    assert.equal(toolInputSchemas.film_create_run.safeParse({ ...valid, plan: { productionSpec: { version: 1, workflowVersion: 2 } } }).success, false);
    const wrongSpecVersion = request();
    wrongSpecVersion.plan.productionSpec.version = 2;
    assert.equal(toolInputSchemas.film_create_run.safeParse(wrongSpecVersion).success, false);
});

test("MCP new whole-film runs reject missing or unversioned preproduction references", () => {
    const original = request();
    for (const name of Object.keys(original.plan.productionSpec.preproduction)) {
        const invalid = structuredClone(original) as Record<string, any>;
        delete invalid.plan.productionSpec.preproduction[name];
        assert.equal(toolInputSchemas.film_create_run.safeParse(invalid).success, false, name);
    }
    const invalid = request();
    invalid.plan.productionSpec.preproduction.brief.outputFingerprint = "";
    assert.equal(toolInputSchemas.film_create_run.safeParse(invalid).success, false);
});

test("MCP new whole-film runs require storyboard timing and a chosen pilot", () => {
    const withoutRows = request();
    withoutRows.plan.productionSpec.preproduction.lockedStoryboard.rowIds = [];
    assert.equal(toolInputSchemas.film_create_run.safeParse(withoutRows).success, false);
    const withoutTiming = request();
    withoutTiming.plan.productionSpec.preproduction.lockedStoryboard.durationFrames = 0;
    assert.equal(toolInputSchemas.film_create_run.safeParse(withoutTiming).success, false);
    const withoutPilot = request();
    withoutPilot.plan.productionSpec.preproduction.pilot.sampleRowIds = [];
    assert.equal(toolInputSchemas.film_create_run.safeParse(withoutPilot).success, false);
});

test("MCP existing-run reads and plan updates remain distinct from new creation", () => {
    assert.equal(toolInputSchemas.film_get_run.safeParse({ runId: "existing-run" }).success, true);
    assert.equal(toolInputSchemas.film_update_plan.safeParse({
        runId: "existing-run", expectedRevision: 3,
        plan: { productionSpec: { version: 1, workflowVersion: 1 } },
    }).success, true);
});
