import assert from "node:assert/strict";
import { test } from "node:test";

import { toolInputSchemas } from "../src/schemas.js";
import { normalizeFilmModelCatalog } from "../src/model-catalog.js";

test("video model tools preserve the requested video capability filters", () => {
    const filters = {
        capability: "video",
        model: "provider::video-model",
        input: { imageCount: 2, videoCount: 1, audioCount: 0 },
        videoSeconds: 12,
        videoOperation: "image_to_video",
        videoRatio: "16:9",
        videoResolution: "1080p",
        videoGenerateAudio: true,
        videoWatermark: false,
        options: { aspectRatio: "16:9", seed: 7 },
    };
    assert.deepEqual(toolInputSchemas.film_list_models.parse(filters), filters);
    assert.deepEqual(toolInputSchemas.film_validate_strategy.parse(filters), filters);
    assert.equal(toolInputSchemas.film_run_operation.safeParse({ operation: "storyboard_plan", mode: "video" }).success, false);
});

test("film model catalog reports omitted audio capabilities as unknown without inferring support", () => {
    const catalog = normalizeFilmModelCatalog({
        models: [
            { value: "mimo", capability: "audio", supports: { audioCapabilities: { tts: "configured", voiceDesign: undefined, music: "unknown" } } },
            { value: "h3", capability: "video", supports: { audioCapabilities: { nativeAudio: "unsupported" } } },
        ],
    }) as { models: Array<{ capability: string; supports: { audioCapabilities: Record<string, unknown> } }> };

    assert.deepEqual(catalog.models[0].supports.audioCapabilities, {
        tts: "configured",
        voiceDesign: "unknown",
        music: "unknown",
        voiceReference: "unknown",
        ambientSound: "unknown",
        soundEffects: "unknown",
        speechRecognition: "unknown",
        alignment: "unknown",
    });
    assert.deepEqual(catalog.models[1].supports.audioCapabilities, { nativeAudio: "unsupported" });
});

test("film task bridge requires an idempotency key and keeps every wait below its 30s bridge deadline", () => {
    const operation = { operation: "storyboard_plan", clientOperationId: "film-operation-test-0001" };
    assert.equal(toolInputSchemas.film_run_operation.safeParse(operation).success, true);
    assert.equal(toolInputSchemas.film_run_operation.safeParse({ operation: operation.operation }).success, false);
    const parsed = toolInputSchemas.film_run_operation.parse({ ...operation, awaitCompletion: true, timeoutMs: 60_000 });
    assert.equal("awaitCompletion" in parsed, false);
    assert.equal("timeoutMs" in parsed, false);

    assert.equal(toolInputSchemas.film_get_tasks.safeParse({ taskIds: ["task-1"], waitMs: 10_000 }).success, true);
    assert.equal(toolInputSchemas.film_get_tasks.safeParse({ taskIds: ["task-1"], waitMs: 15_000 }).success, false);
    assert.equal(toolInputSchemas.film_get_tasks.safeParse({ taskIds: Array.from({ length: 20 }, (_, index) => `task-${index}`) }).success, true);
    assert.equal(toolInputSchemas.film_get_tasks.safeParse({ taskIds: Array.from({ length: 21 }, (_, index) => `task-${index}`) }).success, false);
    assert.equal(toolInputSchemas.film_get_tasks.safeParse({ taskIds: ["task-1"], waitMs: 30_000 }).success, false);
    assert.equal(toolInputSchemas.film_wait_task.safeParse({ taskId: "task-1", timeoutMs: 20_000 }).success, true);
    assert.equal(toolInputSchemas.film_wait_task.safeParse({ taskId: "task-1", timeoutMs: 60_000 }).success, false);
});

test("quality evidence writeback requires a run revision, step id, and structured evidence", () => {
    const request = {
        runId: "run-1",
        expectedRevision: 4,
        stepId: "quality:shot:row-1",
        evidence: { checks: [{ name: "full_decode", status: "passed" }] },
    };
    assert.deepEqual(toolInputSchemas.film_record_step_result.parse(request), request);
    assert.equal(toolInputSchemas.film_record_step_result.safeParse({ ...request, expectedRevision: undefined }).success, false);
    assert.equal(toolInputSchemas.film_record_step_result.safeParse({ ...request, ignored: true }).success, false);
});
