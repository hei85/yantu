import { expect, test } from "bun:test";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor, normalizeModelCapabilityConfig, type ModelCapabilityConfig } from "../src/lib/model-capabilities";
import { canvasDockStyle } from "../src/lib/canvas/canvas-aceternity-style";
import { canvasThemes } from "../src/lib/canvas-theme";
import { createGenerationTaskSubscriptionService, type GenerationTask } from "../src/services/api/task-center";
import { applyGenerationTaskResultToNodes, canvasNodeNeedsTaskResultSync } from "../src/lib/canvas/canvas-generation-task-sync";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { CANVAS_VIDEO_PREVIEW_MAX_ATTEMPTS, canvasVideoPreviewRetryDelay } from "../src/services/canvas-video-preview";

const task = (id: string, status: GenerationTask["status"]): GenerationTask => ({
    id, status, type: "canvas_video", prompt: "fixture", attempts: 1, createdAt: "2026-10-07T00:00:00Z",
    inputJson: JSON.stringify({ mode: "video", metadata: { nodeId: id } }),
    resultJson: JSON.stringify({ mode: "video", video: { resourceId: `result-${id}`, storageKey: `resource:result-${id}`, mimeType: "video/mp4" } }),
});
const node = (id: string, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({
    id, type: CanvasNodeType.Video, position: { x: 0, y: 0 }, width: 320, height: 180,
    metadata: { taskId: id, status: "loading", ...metadata },
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("null capability arrays and objects cannot crash model selection or MCP catalog", () => {
    const malformed = {
        version: 1, observed: null,
        image: { size: null, quality: { values: null, default: null }, transparentBackground: null },
        video: { ratios: null, resolutions: null, operations: null, defaultResolution: null, duration: null, watermark: null, generateAudio: null },
    } as unknown as ModelCapabilityConfig;
    const profile = normalizeModelCapabilityConfig(malformed);
    expect(profile.video!.resolutions.map((value) => value.toUpperCase())).toEqual([]);
    expect(profile.video!.ratios).toEqual([]);
    expect(profile.video!.operations).toEqual([]);
    expect(profile.image!.quality.values).toEqual([]);
    expect(profile.image!.size.values).toEqual([]);
    expect(profile.video!.duration.selection).toBeDefined();
    expect(profile.video!.watermark.supported).toBe(false);
});

test("normalization preserves declared capabilities and drops only invalid option values", () => {
    const config = defaultModelCapabilityConfig("minimax-video", "MiniMax-H3");
    config.video!.resolutions = ["string:768P", null, "768P", 1080, " "] as unknown as string[];
    config.video!.generateAudio = { supported: false, default: false };
    const normalized = normalizeModelCapabilityConfig(config);
    expect(normalized.video!.resolutions).toEqual(["768P"]);
    expect(normalized.video!.generateAudio.supported).toBe(false);
    expect(normalized.video!.duration).toEqual(config.video!.duration);
});

test("routed channel normalization uses its real protocol fallback for nullable nested duration", () => {
    const config = defaultModelCapabilityConfig("minimax-video", "MiniMax-H3");
    config.video!.duration = null as never;
    const profile = modelCapabilityConfigFor({ channels: [{ id: "local", models: ["MiniMax-H3"], modelCosts: [{ model: "MiniMax-H3", protocol: "minimax-video", capabilityConfig: config }] }] }, "local::MiniMax-H3");
    expect(profile.video!.duration).toEqual(defaultModelCapabilityConfig("minimax-video", "MiniMax-H3").video!.duration);
});

test("canvas move/select pill follows both light and dark themes", () => {
    for (const theme of [canvasThemes.light, canvasThemes.dark]) {
        const style = canvasDockStyle(theme) as Record<string, unknown>;
        expect(style["--dock-switch-track"]).toBe(theme.spatial.surface);
        expect(style["--dock-switch-thumb-text"]).toBe(theme.toolbar.activeText);
    }
    expect((canvasDockStyle(canvasThemes.light) as Record<string, unknown>)["--dock-switch-track"]).not.toBe("#000000");
});

test("nine video tasks reconnect and attach their own results without refreshing or resubmitting", async () => {
    const ids = Array.from({ length: 9 }, (_, index) => `task-${index}`);
    const reads = new Map<string, number>();
    const received = new Map<string, GenerationTask>();
    const service = createGenerationTaskSubscriptionService({
        retryDelayMs: 1,
        async queryTask(id) {
            const count = (reads.get(id) || 0) + 1;
            reads.set(id, count);
            if (count === 1) throw new Error("temporary network interruption");
            return task(id, "succeeded");
        },
        async waitTask() { throw new Error("terminal task must not be polled"); },
    });
    let unsubscribe = () => {};
    try {
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("completion delivery timed out")), 1000);
            unsubscribe = service.subscribe(ids, (result) => {
                if (result.status !== "succeeded") return;
                received.set(result.id, result);
                if (received.size === 9) { clearTimeout(timeout); resolve(); }
            });
        });
        let nodes = ids.map((id) => node(id, { generationResultSyncPending: true }));
        for (const result of received.values()) nodes = (await applyGenerationTaskResultToNodes(nodes, result)).nodes;
        expect(nodes.map((item) => item.metadata!.storageKey)).toEqual(ids.map((id) => `resource:result-${id}`));
        expect(nodes.every((item) => item.metadata!.status === "success" && !canvasNodeNeedsTaskResultSync(item))).toBe(true);
        expect([...reads.values()]).toEqual(Array(9).fill(2));
    } finally { unsubscribe(); }
});

test("running task observer reconnects after wait interruption while retaining one subscription", async () => {
    let reads = 0;
    let unsubscribe = () => {};
    const service = createGenerationTaskSubscriptionService({
        retryDelayMs: 1,
        async queryTask(id) { return task(id, ++reads === 1 ? "running" : "succeeded"); },
        async waitTask() { throw new Error("polling connection dropped"); },
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("completion delivery timed out")), 1000);
            unsubscribe = service.subscribe(["running-task"], (result) => {
                if (result.status === "succeeded") { clearTimeout(timeout); resolve(); }
            });
        });
        expect(reads).toBe(2);
    } finally { unsubscribe(); }
});

test("unsubscribing cancels scheduled recovery and terminal failures never enter a retry loop", async () => {
    let reads = 0;
    const service = createGenerationTaskSubscriptionService({
        retryDelayMs: 15,
        async queryTask(id) { reads++; if (id === "disconnected") throw new Error("temporary"); return task(id, "failed"); },
        async waitTask() { throw new Error("unexpected wait"); },
    });
    const unsubscribe = service.subscribe(["disconnected"], () => {});
    await pause(0);
    unsubscribe();
    const stopFailed = service.subscribe(["failed"], () => {});
    await pause(40);
    stopFailed();
    expect(reads).toBe(2);
});

test("one consumer throwing does not prevent another from receiving completion", async () => {
    let received = false;
    const service = createGenerationTaskSubscriptionService({
        async queryTask(id) { return task(id, "succeeded"); },
        async waitTask() { throw new Error("unexpected wait"); },
    });
    const stopBad = service.subscribe(["shared"], () => { throw new Error("bad consumer"); });
    const stopGood = service.subscribe(["shared"], () => { received = true; });
    await pause(0);
    stopBad(); stopGood();
    expect(received).toBe(true);
});

test("result recovery distinguishes empty success, durable storage, and actual upstream failure", () => {
    expect(canvasNodeNeedsTaskResultSync(node("empty", { status: "success", taskStatus: "succeeded" }))).toBe(true);
    expect(canvasNodeNeedsTaskResultSync(node("stored", { status: "success", storageKey: "resource:existing" }))).toBe(false);
    expect(canvasNodeNeedsTaskResultSync(node("failed", { status: "error", taskStatus: "failed" }))).toBe(false);
    expect(canvasNodeNeedsTaskResultSync(node("retry", { status: "loading", taskStatus: "succeeded", generationResultSyncPending: true }))).toBe(true);
});

test("cover failures retry with bounded backoff without creating any video task", () => {
    expect(CANVAS_VIDEO_PREVIEW_MAX_ATTEMPTS).toBe(3);
    expect(canvasVideoPreviewRetryDelay(1)).toBe(2000);
    expect(canvasVideoPreviewRetryDelay(2)).toBe(4000);
    expect(canvasVideoPreviewRetryDelay(3)).toBeUndefined();
});
