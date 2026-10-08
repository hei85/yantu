import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { aspectRatioWithinTolerance, buildFilmDeliveryVerificationRequest, buildFilmSubmitRequest, buildPlanFromSpec, capabilityEvidenceFromConfig, filmAgentToolNames, getFilmTasks, hasCompleteVideoFrameSamples, hydrateProductionPlanFromCanvasStoryboard, isFilmAgentReadTool, isFilmAgentToolName, isShotDurationAcceptable, queryFilmTasks, runFilmAgentTool } from "@/services/api/film-agent-tools";
import { buildFilmProductionPlan, type FilmProductionPlanSpec } from "@/services/api/production-plan";
import type { CanvasNodeData } from "@/types/canvas";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { modelCompatibilityError, resolveCompatibleModel, type ModelRequirements } from "@/lib/model-selection";
import { ApiError } from "@/services/api/request";
import { productionRuns } from "@/services/api/production-runs";
import { defaultConfig, encodeChannelModel, useConfigStore, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

const readSource = (relative: string) => readFileSync(resolve(import.meta.dir, relative), "utf8").replace(/\r\n/g, "\n");

describe("film agent tools", () => {
    test("exposes exactly the pipeline and model-catalog tools", () => {
        expect(filmAgentToolNames).toEqual([
            "film_list_operations",
            "film_list_models",
            "film_sync_local_models",
            "film_validate_strategy",
            "film_create_run",
            "film_get_run",
            "film_update_plan",
            "film_pause_run",
            "film_resume_run",
            "film_cancel_run",
            "film_submit_step",
            "film_probe_media",
            "film_record_model_outputs",
            "film_check_shot",
            "film_record_step_result",
            "film_render_timeline",
            "film_verify_delivery",
            "film_run_operation",
            "film_get_tasks",
            "film_wait_task",
        ]);
        expect(isFilmAgentToolName("film_run_operation")).toBe(true);
        expect(isFilmAgentToolName("canvas_get_state")).toBe(false);
        expect(isFilmAgentReadTool("film_list_operations")).toBe(true);
        expect(isFilmAgentReadTool("film_list_models")).toBe(true);
        expect(isFilmAgentReadTool("film_sync_local_models")).toBe(false);
        expect(isFilmAgentReadTool("film_validate_strategy")).toBe(true);
        expect(isFilmAgentReadTool("film_verify_delivery")).toBe(false);
        expect(isFilmAgentReadTool("film_run_operation")).toBe(false);
        expect(isFilmAgentReadTool("film_record_step_result")).toBe(false);
    });

    test("reuses the existing prompt-template and generation-task services", () => {
        const source = readSource("../src/services/api/film-agent-tools.ts");

        // 只做编排：模板渲染、任务生命周期、产物解析全部走现有服务。
        expect(source).toContain("listAdminPromptTemplates()");
        expect(source).toContain("submitBackendGenerationTask(");
        expect(source).not.toContain("runBackendGenerationTask(");
        expect(source).not.toContain("awaitCompletion");
        expect(source).toContain("= queryGenerationTask");
        expect(source).toContain("parseBackendGenerationResult(");
        // 页面同款调用协议：占位提示词 + promptTemplateOperation + 变量。
        expect(source).toContain("promptTemplateTaskPlaceholder(");
        expect(source).toContain("promptTemplateOperation: operation");
        expect(source).toContain("promptTemplateVariables: variables");
        // 文本规划必须携带稳定幂等键；提交返回 taskId 后由独立短查询跟进。
        expect(source).toContain("const clientOperationId = optionalString(rawInput.clientOperationId)");
        expect(source).toContain("if (!clientOperationId) throw new Error(");
        expect(source).toContain("clientOperationId,");
        expect(source).toContain('nextAction: "film_wait_task"');
        expect(source).toContain("AbortSignal.timeout(20_000)");
        expect(source).toContain("clampNumber(rawInput.timeoutMs, 1_000, 20_000, 10_000)");
        expect(source).toContain("maxFilmTaskBatchSize = 20");
        expect(source).toContain("filmTaskQueryConcurrency = 5");
        expect(source).toContain("clampNumber(rawInput.waitMs, 0, maxFilmTaskWaitMs, 0)");
        // 模型不另起一套：复用产品现有目录、能力档案与兼容路由。
        expect(source).toContain("selectableModelsByCapability(");
        expect(source).toContain("modelCapabilityConfigFor(");
        expect(source).toContain("filmCompatibleModels(");
        expect(source).toContain("normalizeModelOptionValue(");
        expect(source).toContain("compatible: compatible.map(");
        expect(source).toContain("用户指定的${modeLabel(capability)}模型");
        expect(source).toContain("没有可核验的服务端能力版本");
        // 不允许在该模块里自己拼模板或直连供应商。
        expect(source).not.toContain("fetch(\"https://");
        expect(source).not.toContain("Authorization: Bearer");
    });

    test("runs film tools through the page bridge like project tools", () => {
        const bridge = readSource("../src/components/canvas/canvas-local-agent-bridge.tsx");
        const filmTools = readSource("../src/services/api/film-agent-tools.ts");

        expect(bridge).toContain("isFilmAgentToolName(payload.name)");
        expect(bridge).toContain("await runFilmAgentTool(payload.name, input2, { canvasNodes: snapshotRef.current.nodes })");
        expect(bridge).toContain("snapshotRef.current.domainProjectId");
        expect(filmTools).toContain("submitFilmStep(rawInput, context?.canvasNodes)");
        expect(filmTools).toContain("bindProductionTaskCanvasContext(");
        // 最终合片必须复用页面同款 FFmpeg 合并与入库链路，而不是另写一套。
        expect(bridge).toContain('payload.name === "canvas_merge_videos"');
        expect(bridge).toContain("mergeVideos(");
        expect(bridge).toContain("storeGeneratedVideo({ blob })");
    });

    test("production planning uses the current Script segment binding as the authoritative reuse source", () => {
        const sourceNodes = [{
            id: "script-source",
            type: "script",
            title: "source",
            position: { x: 0, y: 0 },
            width: 640,
            height: 420,
            metadata: {
                storyboard: {
                    rows: [{
                        id: "row-1",
                        shotNumber: 1,
                        durationSeconds: 5,
                        videoNodeId: "video-1",
                        segmentBindings: [{
                            segmentId: "segment-1",
                            order: 0,
                            videoNodeId: "video-1",
                            taskId: "task-1",
                            resourceId: "resource-1",
                            status: "succeeded",
                            requestedDurationSeconds: 5,
                            timelineStartMs: 0,
                            timelineDurationMs: 5_000,
                        }],
                    }],
                    visibleColumns: [],
                    referenceNodeIds: [],
                },
            },
        }] as unknown as CanvasNodeData[];
        const plan = {
            productionSpec: {
                version: 1,
                targetDurationMs: 5_000,
                targetAspectRatio: "16:9",
                videoModels: [],
                storyboardRows: [{
                    rowId: "row-1",
                    durationMs: 5_000,
                    segments: [{ segmentId: "segment-1", order: 0, durationSeconds: 5 }],
                }],
            },
        };

        const hydrated = hydrateProductionPlanFromCanvasStoryboard(plan, sourceNodes);
        const spec = hydrated.productionSpec as FilmProductionPlanSpec;
        const built = buildFilmProductionPlan(spec);

        expect(built.steps.filter((step) => step.kind === "reuse_media")).toHaveLength(1);
        expect(built.steps.some((step) => step.kind === "video")).toBe(false);
        expect(built.manifest.reusedMediaBindings).toEqual([
            expect.objectContaining({ storyboardRowId: "row-1", segmentId: "segment-1", resourceId: "resource-1", sourceTaskId: "task-1", sourceNodeId: "video-1" }),
        ]);
        expect(() => hydrateProductionPlanFromCanvasStoryboard({
            productionSpec: {
                ...plan.productionSpec,
                storyboardRows: [{
                    ...plan.productionSpec.storyboardRows[0],
                    segments: [{ segmentId: "segment-1", order: 0, durationSeconds: 5, existingMedia: { resourceId: "other-resource" } }],
                }],
            },
        }, sourceNodes)).toThrow("与当前画布 SegmentBinding 不一致");
    });

    test("delivery verification forwards caller constraints without allowing them to replace the run contract", () => {
        expect(buildFilmDeliveryVerificationRequest({
            runId: "run-180s",
            expectedRevision: 7,
            resourceId: "short-clip",
            expectedDurationMs: 5170,
            expectedAspectRatio: "9:16",
            requireVideo: false,
            requireAudio: false,
        })).toEqual({
            expectedRevision: 7,
            resourceId: "short-clip",
            expectedDurationMs: 5170,
            expectedAspectRatio: "9:16",
            expectedWidth: undefined,
            expectedHeight: undefined,
            requireVideo: undefined,
            requireAudio: undefined,
            requireSubtitle: undefined,
        });
        expect(() => buildFilmDeliveryVerificationRequest({ resourceId: "short-clip" })).toThrow("expectedRevision");
    });

    test("accepts nearby landscape ratios while rejecting portrait output", () => {
        expect(aspectRatioWithinTolerance(1280, 736, "16:9")).toBe(true);
        expect(aspectRatioWithinTolerance(1376, 768, "16:9")).toBe(true);
        expect(aspectRatioWithinTolerance(736, 1280, "16:9")).toBe(false);
        expect(aspectRatioWithinTolerance(0, 0, "16:9")).toBe(false);
    });

    test("shot QA requires real decoded start, middle, and end video-frame samples", () => {
        const source = readSource("../src/services/api/film-agent-tools.ts");
        expect(source).toContain('name: "video_frame_samples"');
        expect(source).toContain('["start", "middle", "end"]');
        expect(source).toContain("sample.decoded && sample.imageBytes > 8");
        expect(hasCompleteVideoFrameSamples(undefined)).toBe(false);
        expect(hasCompleteVideoFrameSamples([
            { position: "start", timestampMs: 0, decoded: true, imageBytes: 32 },
            { position: "middle", timestampMs: 500, decoded: true, imageBytes: 32 },
            { position: "end", timestampMs: 950, decoded: true, imageBytes: 32 },
        ])).toBe(true);
        expect(hasCompleteVideoFrameSamples([
            { position: "start", timestampMs: 0, decoded: true, imageBytes: 32 },
            { position: "middle", timestampMs: 500, decoded: false, imageBytes: 32 },
            { position: "end", timestampMs: 950, decoded: true, imageBytes: 32 },
        ])).toBe(false);
    });

    test("shot duration allows a subsecond overshoot but rejects the next whole second", () => {
        expect(isShotDurationAcceptable(13_667, 13_000)).toBe(true);
        expect(isShotDurationAcceptable(13_999, 13_000)).toBe(true);
        expect(isShotDurationAcceptable(14_000, 13_000)).toBe(false);
        expect(isShotDurationAcceptable(12_700, 13_000)).toBe(true);
        expect(isShotDurationAcceptable(12_699, 13_000)).toBe(false);
    });

    test("agent declares and routes the film, storyboard and merge tools", () => {
        const schemas = readSource("../../canvas-agent/src/schemas.ts");
        const session = readSource("../../canvas-agent/src/canvas-session.ts");
        const prompt = readSource("../../canvas-agent/src/config.ts");
        const bridge = readSource("../src/components/canvas/canvas-local-agent-bridge.tsx");

        for (const name of filmAgentToolNames) expect(schemas).toContain(`"${name}"`);
        expect(schemas).toContain("film_run_operation: z.object({");
        expect(schemas).toContain("clientOperationId: z.string().min(1).max(120)");
        expect(schemas).not.toContain("awaitCompletion: z.boolean().optional()");
        expect(schemas).toContain("taskIds: z.array(z.string().min(1)).min(1).max(20), waitMs: z.number().int().min(0).max(10000)");
        expect(schemas).toContain("timeoutMs: z.number().int().min(1000).max(20000)");
        expect(session).toContain('if (tool.startsWith("film_"))');
        expect(session).toContain("当前没有已连接的衍图页面");

        // 结构化分镜与最终交付：Agent 必须能读写真实 StoryboardRow、能渲染并验收交付合同。
        for (const name of ["canvas_get_storyboard", "canvas_update_storyboard", "canvas_merge_videos"]) {
            expect(schemas).toContain(`"${name}"`);
            expect(session).toContain(`"${name}"`);
        }
        expect(schemas).toContain("storyboardRowSchema");
        expect(schemas).toContain("durationSeconds: z.number().finite().min(0).max(3600)");
        expect(session).toContain("mergeStoryboardRows(");
        // Control invariants live here; film rules are loaded from versioned skills.
        expect(prompt).toContain("production instructions are loaded as skills");
        expect(prompt).toContain("runtime_diagnostics");
        expect(prompt).toContain("canvas_list_open_canvases");
        expect(prompt).not.toContain("反向之地");
        expect(session).toContain('tool === "film_self_check"');
        expect(session).toContain("auditFilmWorkflow");
        expect(bridge).toContain("if (!open || !snapshot.projectId) return;");
        expect(bridge).toContain("}, [open, snapshot.projectId]);");
    });

    test("runtime returns the real tool error message to the MCP client", () => {
        const security = readSource("../../canvas-agent/src/local-runtime-security.ts");
        const mcp = readSource("../../canvas-agent/src/mcp-server.ts");

        expect(security).toContain('code: "runtime_internal_error"');
        expect(security).toContain("error: error instanceof Error ? error.message : String(error || \"\")");
        expect(mcp).toContain("body.error");
    });

    test("prompt operations cannot trigger hidden paid video generation", async () => {
        await expect(runFilmAgentTool("film_run_operation", { operation: "storyboard_plan", mode: "video" })).rejects.toThrow("只执行文本规划");
    });

    test("partial ProductionRun render context cannot fall through to a standalone timeline task", async () => {
        const timeline = { version: 2, tracks: [], clips: [], durationMs: 1000 };
        await expect(runFilmAgentTool("film_render_timeline", { projectId: "project-1", timeline, runId: "run-1" }))
            .rejects.toThrow("必须同时提供 runId、stepId、idempotencyKey 和 expectedRevision");
        await expect(runFilmAgentTool("film_render_timeline", { projectId: "project-1", timeline, retryOf: "attempt-old" }))
            .rejects.toThrow("必须同时提供 runId、stepId、idempotencyKey 和 expectedRevision");
    });

    test("默认模型继承：未指定模型时读回文本/图片/视频/音频默认模型并归一成合法模型选项", async () => {
        useCatalog(modelCatalog());

        const listed = await runFilmAgentTool("film_list_models", {}) as {
            defaults: Record<string, string>;
            models: Array<{ capability: string; supports: { capabilityRevision: string; audioCapabilities?: { nativeAudio: string } } }>;
        };

        // 默认模型必须以 channelId::model 形式返回，兼容路由才能按同族分组落档。
        expect(listed.defaults).toEqual({
            text: "studio::text-one",
            image: "studio::image-one",
            video: "studio::video-narrow",
            audio: "studio::audio-one",
        });
        expect(new Set(listed.models.map((item) => item.capability))).toEqual(new Set(["text", "image", "video", "audio"]));
        expect(listed.models.find((item) => item.capability === "video" && item.supports.capabilityRevision === "cm-video-narrow:5")).toBeDefined();
        expect(listed.models.find((item) => item.capability === "video")?.supports.audioCapabilities?.nativeAudio).toBe("unknown");
    });

    test("网页模型未同步时报出能力阻断并将未知价格作为显式授权要求", async () => {
        const config = modelCatalog();
        config.channels[0].models = config.channels[0].models.filter((model) => model !== "audio-one");
        config.channels[0].modelCosts = config.channels[0].modelCosts?.filter((item) => item.model !== "audio-one")
            .map((item) => ({ ...item, channelModelId: undefined, capabilityVersion: undefined }));
        config.audioModels = [];
        config.audioModel = "";
        useCatalog(config);

        const listed = await runFilmAgentTool("film_list_models", { capability: "video" }) as {
            recommendedSubmissionReady: boolean;
            productionReadiness: {
                versionedModelCount: number;
                audioModelCount: number;
                audioSwitchSupportedVideoModelCount: number;
                mediaPricing: { status: string; requiredPolicy: string };
                blockers: Array<{ code: string }>;
                nextTools: string[];
            };
        };
        expect(listed.recommendedSubmissionReady).toBe(false);
        expect(listed.productionReadiness).toMatchObject({
            versionedModelCount: 0,
            audioModelCount: 0,
            audioSwitchSupportedVideoModelCount: 0,
        });
        expect(listed.productionReadiness.blockers.map((item) => item.code)).toEqual([
            "server_model_catalog_empty",
            "native_audio_control_unverified",
        ]);
        expect(listed.productionReadiness.mediaPricing).toMatchObject({ status: "unknown", requiredPolicy: "verified estimate or explicitly authorized unbounded budget" });
        expect(listed.productionReadiness.nextTools).toEqual(["film_sync_local_models", "film_list_models"]);
    });

    test("文本规划不会向缺少后端能力版本的本地模型提交任务", async () => {
        const config = modelCatalog();
        config.channels[0].modelCosts = config.channels[0].modelCosts?.map((item) => ({
            ...item,
            channelModelId: undefined,
            capabilityVersion: undefined,
        }));
        useCatalog(config);
        await expect(runFilmAgentTool("film_run_operation", {
            operation: "storyboard_plan",
            clientOperationId: "plan-without-server-model",
        })).rejects.toThrow("film_sync_local_models");
    });

    test("显式选择未同步到后端目录的型号不能通过持久制作校验", async () => {
        const config = modelCatalog();
        config.channels[0].modelCosts = config.channels[0].modelCosts?.map((item) => item.model === "video-wide"
            ? { ...item, channelModelId: undefined, capabilityVersion: undefined }
            : item);
        useCatalog(config);

        const result = await runFilmAgentTool("film_validate_strategy", {
            capability: "video", model: "studio::video-wide",
            videoOperation: "text_to_video", videoSeconds: "10", videoRatio: "16:9",
        }) as { ok: boolean; recommended: string; requestedError: string };
        expect(result.ok).toBe(false);
        expect(result.recommended).toBe("");
        expect(result.requestedError).toContain("未登记服务端能力版本");
    });

    test("默认模型能力不足：同族兼容路由换档，model_list 给出 compatible 与 recommended", async () => {
        const config = modelCatalog();
        useCatalog(config);

        const requirements: ModelRequirements = {
            capability: "video",
            input: { textCount: 1, imageCount: 2, videoCount: 0, audioCount: 0, characterCount: 0 },
            videoSeconds: "10",
        };

        // 默认（窄档）确实不支持该任务，换档不是“本来就能跑”。
        expect(modelCompatibilityError(config, "studio::video-narrow", requirements)).not.toBe("");
        expect(modelCompatibilityError(config, "studio::video-wide", requirements)).toBe("");
        expect(resolveCompatibleModel(config, "studio::video-narrow", requirements)).toBe("studio::video-wide");

        const listed = await runFilmAgentTool("film_list_models", { capability: "video", videoSeconds: "10", input: { imageCount: 2 } }) as {
            requested: string;
            recommended: string;
            compatible: Array<{ value: string }>;
        };
        expect(listed.requested).toBe("studio::video-narrow");
        expect(listed.recommended).toBe("studio::video-wide");
        expect(listed.compatible.map((item) => item.value)).toEqual(["studio::video-wide"]);
    });

    test("视频策略保留显式时长、画幅、分辨率和 false 布尔参数，不回退到全局默认值", async () => {
        const config = modelCatalog();
        const wide = config.channels[0].modelCosts?.find((item) => item.model === "video-wide");
        if (!wide?.capabilityConfig?.video) throw new Error("fixture missing wide video capability");
        wide.capabilityConfig.video.duration = { selection: "enum", values: [5], default: 5 };
        wide.capabilityConfig.video.ratios = ["16:9"];
        wide.capabilityConfig.video.resolutions = ["736P"];
        wide.capabilityConfig.video.generateAudio.supported = true;
        wide.capabilityConfig.video.watermark.supported = true;
        // Deliberately conflicting user defaults expose accidental fallback.
        config.size = "9:16";
        config.videoSeconds = "6";
        config.vquality = "720";
        config.videoGenerateAudio = "true";
        config.videoWatermark = "true";
        useCatalog(config);

        const strategy = await runFilmAgentTool("film_validate_strategy", {
            capability: "video",
            model: "studio::video-wide",
            input: { textCount: 1, imageCount: 0 },
            videoSeconds: "5",
            videoOperation: "text_to_video",
            videoRatio: "16:9",
            videoResolution: "736P",
            videoGenerateAudio: false,
            videoWatermark: false,
        }) as { ok: boolean; requirements: ModelRequirements };

        expect(strategy.ok).toBe(true);
        expect(strategy.requirements).toMatchObject({
            videoSeconds: "5",
            videoRatio: "16:9",
            videoResolution: "736P",
            videoGenerateAudio: false,
            videoWatermark: false,
            options: {
                size: "16:9",
                videoSeconds: "5",
                vquality: "736P",
                videoGenerateAudio: false,
                videoWatermark: false,
            },
        });
    });

    test("视频原生音频默认值按型号能力路由，只有显式请求才筛除不支持的型号", async () => {
        const config = modelCatalog();
        const wide = config.channels[0].modelCosts?.find((item) => item.model === "video-wide");
        if (!wide?.capabilityConfig?.video) throw new Error("fixture missing wide video capability");
        wide.capabilityConfig.video.generateAudio = { supported: true, default: true };
        config.videoGenerateAudio = "true"; // A stale global default must not affect model-specific routing.
        useCatalog(config);

        const defaults = await runFilmAgentTool("film_list_models", { capability: "video" }) as {
            requested: string;
            compatible: Array<{ value: string }>;
        };
        expect(defaults.requested).toBe("studio::video-narrow");
        expect(defaults.compatible.map((item) => item.value)).toEqual(["studio::video-narrow", "studio::video-wide"]);
        const defaultStrategy = await runFilmAgentTool("film_validate_strategy", { capability: "video" }) as {
            ok: boolean;
            requirements: ModelRequirements;
        };
        expect(defaultStrategy.ok).toBe(true);
        expect(defaultStrategy.requirements.options).not.toHaveProperty("videoGenerateAudio");

        const nativeAudio = await runFilmAgentTool("film_list_models", {
            capability: "video",
            videoGenerateAudio: true,
        }) as { recommended: string; compatible: Array<{ value: string }> };
        expect(nativeAudio.recommended).toBe("studio::video-wide");
        expect(nativeAudio.compatible.map((item) => item.value)).toEqual(["studio::video-wide"]);
    });

    test("用户显式指定模型优先于默认模型，认不出的名字原样交给底层校验", async () => {
        const config = modelCatalog();
        useCatalog(config);

        // 裸模型名也会被归一成合法模型选项，保证落到正确渠道。
        const explicit = await runFilmAgentTool("film_list_models", { capability: "video", model: "video-wide" }) as { requested: string };
        expect(explicit.requested).toBe("studio::video-wide");

        const unknown = await runFilmAgentTool("film_list_models", { capability: "video", model: "not-in-catalog" }) as { requested: string };
        expect(unknown.requested).toBe("not-in-catalog");

        config.channels.push({ ...structuredClone(config.channels[0]!), id: "second-studio", name: "第二渠道" });
        useCatalog(config);
        await expect(runFilmAgentTool("film_list_models", { capability: "video", model: "video-wide" }))
            .rejects.toThrow("模型名 video-wide 存在于多个渠道");
    });

    test("视频步骤按能力目录自动选兼容模型，显式模型锁定且能力版本、费用与 retryOf 一起提交", () => {
        const config = modelCatalog();
        const base = {
            runId: "run-video",
            expectedRevision: 4,
            stepId: "shot-01-video",
            idempotencyKey: "attempt-2",
            estimatedCostMicros: 125000,
            retryOf: "attempt-1",
            task: {
                type: "canvas_video",
                prompt: "fixture video",
                input: { mode: "video", videoSeconds: "10", videoOperation: "image_to_video", referenceImages: [{ id: "asset-1" }, { id: "asset-2" }], aspectRatio: "16:9", resolution: "1080p" },
            },
        };
        const selected = buildFilmSubmitRequest(base, config);
        expect(selected.runId).toBe("run-video");
        expect(selected.request.task.model).toBe("studio::video-wide");
        expect(selected.request.capabilityRevision).toBe("cm-video-wide:8");
        expect(selected.request.estimatedCostMicros).toBe(125000);
        expect(selected.request.retryOf).toBe("attempt-1");
        expect(selected.modelSelection).toMatchObject({ requested: "studio::video-narrow", switched: true, explicit: false });

        expect(() => buildFilmSubmitRequest({
            ...base,
            task: { ...base.task, model: "video-narrow" },
        }, config)).toThrow("用户指定的视频模型");
        expect(() => buildFilmSubmitRequest({ ...base, estimatedCostMicros: undefined }, config)).toThrow("只有已授权的无上限预算");
        expect(() => buildFilmSubmitRequest({ ...base, estimatedCostMicros: 0 }, config)).toThrow("只有已授权的无上限预算");
        expect(buildFilmSubmitRequest({ ...base, estimatedCostMicros: 0 }, config, true).request.estimatedCostMicros).toBe(0);
    });

    test("自动视频选型会跨显示名模型寻找兼容项，显式指定仍保持锁定", () => {
        const config = modelCatalog();
        const wide = config.channels[0].modelCosts?.find((item) => item.model === "video-wide");
        if (!wide) throw new Error("fixture missing wide model");
        wide.displayName = "Reference Motion XL";
        wide.capabilityConfig!.video!.operations = ["image_to_video"];
        wide.capabilityConfig!.video!.duration = { selection: "enum", values: [10], default: 10 };
        wide.capabilityConfig!.video!.ratios = ["16:9"];
        wide.capabilityConfig!.video!.resolutions = ["1080p"];
        wide.capabilityConfig!.video!.generateAudio.supported = true;
        wide.capabilityConfig!.video!.watermark.supported = true;
        const raw = {
            runId: "run-cross-group",
            expectedRevision: 1,
            stepId: "shot-02-video",
            idempotencyKey: "attempt-cross-group",
            estimatedCostMicros: 2500,
            task: {
                type: "video",
                prompt: "fixture video",
                input: { mode: "video", videoSeconds: "10", videoOperation: "image_to_video", referenceImages: [{ id: "asset-1" }, { id: "asset-2" }] },
            },
        };
        const automatic = buildFilmSubmitRequest(raw, config);
        expect(automatic.request.task.model).toBe("studio::video-wide");
        expect(automatic.request.task.input).toEqual(raw.task.input);
        expect(automatic.modelSelection).toMatchObject({ requested: "studio::video-narrow", switched: true, explicit: false });
        expect(() => buildFilmSubmitRequest({ ...raw, task: { ...raw.task, model: "video-narrow" } }, config)).toThrow("用户指定的视频模型");

        useCatalog(config);
        const filters = {
            capability: "video",
            input: { imageCount: 2 },
            videoSeconds: "10",
            videoOperation: "image_to_video",
            videoRatio: "16:9",
            videoResolution: "1080p",
            videoGenerateAudio: true,
            videoWatermark: true,
        };
        const listed = runFilmAgentTool("film_list_models", filters) as Promise<{ recommended: string; compatible: Array<{ value: string }>; recommendedSubmissionReady: boolean }>;
        const validated = runFilmAgentTool("film_validate_strategy", filters) as Promise<{ ok: boolean; recommended: string; switched: boolean }>;
        return Promise.all([listed, validated]).then(([catalog, strategy]) => {
            expect(catalog.recommended).toBe("studio::video-wide");
            expect(catalog.compatible.map((item) => item.value)).toEqual(["studio::video-wide"]);
            expect(catalog.recommendedSubmissionReady).toBe(true);
            expect(strategy).toMatchObject({ ok: true, recommended: "studio::video-wide", switched: true });
        });
    });

    test("batch task polling is bounded, ordered, and keeps per-task read failures structured", async () => {
        const ids = Array.from({ length: 12 }, (_, index) => `task-${index}`);
        let active = 0;
        let maximumActive = 0;
        const signals = new Set<AbortSignal>();
        const tasks = await queryFilmTasks(ids, async (id, options) => {
            active++;
            maximumActive = Math.max(maximumActive, active);
            if (options?.signal) signals.add(options.signal);
            await new Promise((resolve) => setTimeout(resolve, 2));
            active--;
            if (id === "task-7") throw new Error("temporary read failure");
            return { id, status: "running" };
        });

        expect(maximumActive).toBeLessThanOrEqual(5);
        expect(signals.size).toBe(1);
        expect([...signals][0]).toBeInstanceOf(AbortSignal);
        expect(tasks.map((task) => task.id)).toEqual(ids);
        expect(tasks[7]).toMatchObject({ id: "task-7", status: "unknown", error: "temporary read failure" });
        expect(tasks[7]?.queryError).toMatchObject({ name: "Error", message: "temporary read failure", retryable: false });

        const apiFailure = await queryFilmTasks(["task-429"], async () => {
            throw new ApiError("上游暂不可用", { status: 503, code: 12001, reason: "upstream_unavailable", retryable: true, retryAfterMs: 4500 });
        });
        expect(apiFailure[0]).toMatchObject({
            status: "unknown",
            error: "上游暂不可用",
            queryError: { status: 503, code: 12001, reason: "upstream_unavailable", retryable: true, retryAfterMs: 4500 },
        });
        const timedOut = await queryFilmTasks(["task-slow"], async (_id, options) => new Promise((_resolve, reject) => {
            if (options?.signal?.aborted) reject(options.signal.reason);
            else options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        }), 1);
        expect(timedOut[0]).toMatchObject({
            id: "task-slow",
            status: "unknown",
            queryError: { name: "TimeoutError", retryable: true, retryAfterMs: 3000 },
        });
        await expect(queryFilmTasks(Array.from({ length: 21 }, (_, index) => `task-${index}`), async (id) => ({ id, status: "running" })))
            .rejects.toThrow("一次最多查询 20 个任务");
    });

    test("MiniMax H3 family limits both model discovery and production planning", async () => {
        const config = modelCatalog();
        const h3 = defaultModelCapabilityConfig(undefined, "minimax_h3_z0902");
        h3.video!.operations = ["text_to_video", "image_to_video"];
        h3.video!.references.minImages = 0;
        h3.video!.references.maxImages = 3;
        h3.video!.ratios = ["16:9"];
        h3.video!.duration = { selection: "enum", values: [5], default: 5 };
        h3.observed = [
            { verdict: "supported", feature: "native_audio_output", source: "media_probe", reason: "task-1 视频有音轨" },
            { verdict: "observed", feature: "video_output_profile", source: "media_probe", reason: "taskId=task-1", details: { width: 1280, height: 720, durationMs: 5012, inputCounts: { referenceImages: 2, referenceVideos: 0, referenceAudios: 0 } } },
        ];
        config.channels[0].models.push("minimax_h3_z0902");
        config.channels[0].modelCosts!.push({ model: "minimax_h3_z0902", displayName: "MiniMax H3 Z0902", description: "H3 series video model for image-driven cinematic clips", capability: "video", capabilityConfig: h3, channelModelId: "cm-h3", capabilityVersion: 2 });
        const h3Unknown = defaultModelCapabilityConfig(undefined, "minimax_h3_z0901");
        h3Unknown.video!.operations = ["text_to_video"];
        h3Unknown.video!.ratios = ["16:9"];
        h3Unknown.video!.duration = { selection: "enum", values: [5], default: 5 };
        config.channels[0].models.push("minimax_h3_z0901");
        config.channels[0].modelCosts!.push({ model: "minimax_h3_z0901", capability: "video", capabilityConfig: h3Unknown, channelModelId: "cm-h3-unknown", capabilityVersion: 1 });
        config.models.push("studio::minimax_h3_z0902");
        config.videoModels.push("studio::minimax_h3_z0902");
        config.models.push("studio::minimax_h3_z0901");
        config.videoModels.push("studio::minimax_h3_z0901");
        useCatalog(config);

        const listed = await runFilmAgentTool("film_list_models", {
            capability: "video", options: { videoModelFamily: "MiniMax H3" },
            videoOperation: "image_to_video", videoSeconds: 5, videoRatio: "16:9", input: { textCount: 1, imageCount: 2 },
        }) as { videoModelFamily: string; compatible: Array<{ value: string; name: string; description: string; capability: string; supports: { generateAudio: boolean; audioCapabilities: { nativeAudio: string }; observedVideoOutputs: Array<{ details: { width: number; height: number; durationMs: number; inputCounts: { referenceImages: number } } }> } }> };
        expect(listed.videoModelFamily).toBe("minimax_h3");
        expect(listed.compatible.map((item) => item.value)).toEqual(["studio::minimax_h3_z0902"]);
        expect(listed.compatible[0]?.supports).toMatchObject({ generateAudio: false, audioCapabilities: { nativeAudio: "observed" } });
        expect(listed.compatible[0]?.supports.observedVideoOutputs).toMatchObject([{ details: { width: 1280, height: 720, durationMs: 5012, inputCounts: { referenceImages: 2 } } }]);
        expect(listed.compatible[0]).toMatchObject({ name: "MiniMax H3 Z0902", description: "H3 series video model for image-driven cinematic clips", capability: "video" });

        const withSound = await runFilmAgentTool("film_list_models", {
            capability: "video", videoModelFamily: "minimax_h3", audioOutputRequired: true,
            videoOperation: "text_to_video", videoSeconds: 5, videoRatio: "16:9",
        }) as { recommended: string; compatible: Array<{ value: string }> };
        expect(withSound.recommended).toBe("studio::minimax_h3_z0902");
        expect(withSound.compatible[0]?.value).toBe("studio::minimax_h3_z0902");

        const rejected = await runFilmAgentTool("film_validate_strategy", {
            capability: "video", model: "studio::video-wide", options: { videoModelFamily: "minimax_h3" },
        }) as { ok: boolean; errors: string[]; recommended: string; actions: string[] };
        expect(rejected.ok).toBe(false);
        expect(rejected.errors[0]).toContain("不属于指定的 minimax_h3 系列");
        expect(rejected.recommended).toBe("");
        expect(rejected.actions).toEqual(["调整当前输入以适配指定模型", "或由用户重新指定模型"]);

        const unsupportedInput = await runFilmAgentTool("film_validate_strategy", {
            capability: "video", model: "studio::minimax_h3_z0901",
            videoOperation: "image_to_video", videoSeconds: 5, videoRatio: "16:9",
            input: { textCount: 1, imageCount: 2 },
        }) as { ok: boolean; errors: string[]; recommended: string };
        expect(unsupportedInput.ok).toBe(false);
        expect(unsupportedInput.errors[0]).toContain("仅支持文生视频");
        expect(unsupportedInput.recommended).toBe("");

        const spec: FilmProductionPlanSpec = {
            version: 1, targetDurationMs: 5000, targetAspectRatio: "16:9",
            videoModels: [
                { value: "studio::video-wide", supports: { capabilityRevision: "cm-video-wide:8" } },
                { value: "studio::minimax_h3_z0902", supports: { capabilityRevision: "cm-h3:2", maxReferenceImages: 99 } },
            ],
            storyboardRows: [{ rowId: "h3-shot", durationMs: 5000, videoOperation: "image_to_video", referenceImageCount: 2, segments: [{ segmentId: "h3-segment", order: 0, durationSeconds: 5, estimatedCostMicros: 1000 }] }],
        };
        const built = buildPlanFromSpec({ productionSpec: spec }, { videoModelFamily: "minimax_h3" });
        const manifest = built.plan.executionManifest as Record<string, unknown>;
        expect((manifest.selectedModelsBySegment as Array<Record<string, unknown>>)[0]?.model).toBe("studio::minimax_h3_z0902");
        expect((built.plan.productionSpec as FilmProductionPlanSpec).videoModels[0].supports.maxReferenceImages).toBe(3);
        const barePins = buildPlanFromSpec({ productionSpec: {
            ...spec,
            selectedVideoModel: "minimax_h3_z0902",
            storyboardRows: [{ ...spec.storyboardRows[0], videoModel: "minimax_h3_z0902", segments: [{ ...spec.storyboardRows[0].segments![0], model: "minimax_h3_z0902" }] }],
        } }, { videoModelFamily: "minimax_h3" });
        expect((barePins.plan.executionManifest as Record<string, unknown>).selectedModelsBySegment)
            .toEqual([expect.objectContaining({ model: "studio::minimax_h3_z0902" })]);
        expect(() => buildPlanFromSpec({ productionSpec: { ...spec, storyboardRows: [{ ...spec.storyboardRows[0], referenceImageCount: 5 }] } }, { videoModelFamily: "minimax_h3" })).toThrow("没有兼容片段");
    });

    test("model discovery reports explicit first and last frame slots only for the verified H3 frame SKUs", async () => {
        const config = modelCatalog();
        const explicitlyConfigured = config.channels[0]!.modelCosts!.find((item) => item.model === "video-wide")?.capabilityConfig?.video;
        if (!explicitlyConfigured) throw new Error("fixture missing video capability");
        explicitlyConfigured.references.frameSlots = {
            firstFrame: { min: 1, max: 1 },
            lastFrame: { min: 0, max: 1 },
            operations: ["image_to_video"],
        };
        const models = ["minimax_h3_b99_002", "minimax_h3_lightx2v", "minimax_h3_z0902"];
        for (const model of models) {
            const profile = defaultModelCapabilityConfig(undefined, model);
            profile.video!.operations = ["image_to_video"];
            profile.video!.references.minImages = model === "minimax_h3_z0902" ? 1 : 2;
            profile.video!.references.maxImages = model === "minimax_h3_z0902" ? 6 : 2;
            config.channels[0]!.models.push(model);
            config.channels[0]!.modelCosts!.push({ model, capability: "video", capabilityConfig: profile, channelModelId: `cm-${model}`, capabilityVersion: 1 });
            const value = `studio::${model}`;
            config.models.push(value);
            config.videoModels.push(value);
        }
        useCatalog(config);

        const listed = await runFilmAgentTool("film_list_models", { capability: "video" }) as {
            models: Array<{ value: string; supports: { inputSlots: Record<string, { min: number; max: number; required: boolean }> } }>;
        };
        const slots = Object.fromEntries(listed.models.map((item) => [item.value, item.supports.inputSlots]));
        for (const model of models.slice(0, 2)) {
            expect(slots[`studio::${model}`]).toMatchObject({
                firstFrame: { required: true, min: 1, max: 1 },
                lastFrame: { required: true, min: 1, max: 1 },
            });
        }
        expect(slots["studio::minimax_h3_z0902"]).toMatchObject({
            firstFrame: { required: true, min: 1, max: 6 },
            lastFrame: { required: false, min: 0, max: 0 },
        });
        expect(slots["studio::video-wide"]).toMatchObject({
            firstFrame: { required: true, min: 1, max: 1 },
            lastFrame: { required: false, min: 0, max: 1 },
        });
    });

    test("film_update_plan inherits unknown pricing only from the persisted run budget policy", async () => {
        useCatalog(modelCatalog());
        const originalGet = productionRuns.get;
        const originalUpdatePlan = productionRuns.updatePlan;
        const run = {
            id: "run-update-price",
            policy: { authorizationStatus: "authorized", budgetPolicy: "unbounded" },
            brief: { targetDurationMs: 5000, aspectRatio: "16:9" },
            deliveryContract: { targetDurationMs: 5000, targetAspectRatio: "16:9" },
            domainProjectId: "",
        };
        let savedPlan: Record<string, unknown> | undefined;
        productionRuns.get = (async () => run as never) as typeof productionRuns.get;
        productionRuns.updatePlan = (async (_id, input) => {
            savedPlan = input.plan;
            return run as never;
        }) as typeof productionRuns.updatePlan;
        const productionSpec: FilmProductionPlanSpec = {
            version: 1,
            targetDurationMs: 5000,
            targetAspectRatio: "16:9",
            videoModels: [{ value: "studio::video-wide", supports: { capabilityRevision: "cm-video-wide:8" } }],
            storyboardRows: [{
                rowId: "update-row",
                durationMs: 5000,
                videoOperation: "text_to_video",
                segments: [{ segmentId: "update-segment", order: 0, durationSeconds: 5, estimatedCostMicros: 0 }],
            }],
        };
        try {
            await runFilmAgentTool("film_update_plan", {
                runId: run.id,
                expectedRevision: 4,
                plan: { productionSpec },
                // A request field cannot elevate a persisted bounded run.
                policy: { budgetPolicy: "bounded" },
            });
            expect((savedPlan?.executionManifest as Record<string, unknown>)?.pricing).toMatchObject({ status: "unknown", estimateMicros: 0 });

            run.policy = { authorizationStatus: "authorized", budgetPolicy: "bounded" };
            savedPlan = undefined;
            await expect(runFilmAgentTool("film_update_plan", {
                runId: run.id,
                expectedRevision: 5,
                plan: { productionSpec },
                policy: { budgetPolicy: "unbounded" },
            })).rejects.toThrow("未知价格仅可使用已授权的无上限预算");
            expect(savedPlan).toBeUndefined();
        } finally {
            productionRuns.get = originalGet;
            productionRuns.updatePlan = originalUpdatePlan;
        }
    });

    test("preserves structured media probe details in capability evidence without inferring ranges", () => {
        const evidence = capabilityEvidenceFromConfig({ observed: [{
            verdict: "observed", feature: "video_output_profile", source: "media_probe", at: "2026-09-30T00:00:00.000Z",
            details: { width: 1280, height: 720, durationMs: 5012, inputCounts: { referenceImages: 1 } },
        }] });
        expect(evidence).toMatchObject([{ feature: "video_output_profile", details: { width: 1280, height: 720, durationMs: 5012 } }]);
        expect(evidence[0]).not.toHaveProperty("minDurationMs");
        expect(evidence[0]).not.toHaveProperty("maxDurationMs");
    });

    test("plan preflight warns when the contract needs audio but the locked model declares no native audio", () => {
        const config = modelCatalog();
        const video = config.channels[0].modelCosts?.find((item) => item.model === "video-narrow")?.capabilityConfig?.video;
        if (!video) throw new Error("fixture missing video capability");
        video.operations = ["text_to_video"];
        video.ratios = ["16:9"];
        video.resolutions = ["736P"];
        video.generateAudio = { supported: false, default: false };
        useCatalog(config);
        const spec: FilmProductionPlanSpec = {
            version: 1,
            targetDurationMs: 5000,
            targetAspectRatio: "16:9",
            // spec 本身不要求音轨；真正的音轨要求来自 Brief/交付合同（后端才做归一化）。
            videoModels: [{ value: "studio::video-narrow", supports: { capabilityRevision: "cm-video-narrow:5" } }],
            storyboardRows: [{ rowId: "row-1", durationMs: 5000, segments: [{ segmentId: "row-1-seg-0", order: 0, durationSeconds: 5, estimatedCostMicros: 1000 }] }],
        };
        const built = buildPlanFromSpec({ productionSpec: spec }, {
            targetDurationMs: 5000,
            brief: { targetDurationMs: 5000, aspectRatio: "16:9", audioPolicy: "native" },
            deliveryContract: { targetDurationMs: 5000, targetAspectRatio: "16:9", requireAudio: true },
        });
        const preflight = (built.plan.executionManifest as Record<string, unknown>).preflight as Record<string, unknown>;
        const warnings = preflight.audioContractWarnings as Array<Record<string, unknown>>;
        expect(warnings?.[0]).toMatchObject({ code: "native_audio_output_requires_probe", severity: "warning" });
        expect((warnings?.[0]?.segments as Array<Record<string, unknown>>)?.[0]).toMatchObject({ storyboardRowId: "row-1", segmentId: "row-1-seg-0", model: "studio::video-narrow" });
    });

    test("failed terminal tasks without a result keep structured state instead of failing the batch", async () => {
        const batch = await getFilmTasks({ taskIds: ["task-failed"] }, async (id) => ({
            id,
            type: "canvas_video",
            status: "failed",
            error: "任务输入解析失败",
            errorCode: "invalid_task_input",
        } as never));
        expect(batch.tasks[0]).toMatchObject({
            taskId: "task-failed",
            status: "failed",
            terminal: true,
            error: "任务输入解析失败",
            errorCode: "invalid_task_input",
        });
        expect(batch.tasks[0]?.result).toBeUndefined();
    });

    test("task snapshots keep the server poll schedule and return retry guidance without changing task identity", async () => {
        const nextPollAt = "2026-09-25T03:00:00.000Z";
        const pending = await getFilmTasks({ taskIds: ["task-running"] }, async (id) => ({
            id,
            status: "running",
            stage: "视频生成中",
            pollStage: "provider_poll",
            nextPollAt,
        }));
        expect(pending.tasks[0]).toMatchObject({ taskId: "task-running", status: "running", stage: "provider_poll", nextPollAt });

        const completed = await getFilmTasks({ taskIds: ["task-complete"] }, async (id) => ({
            id, status: "succeeded", model: "studio::minimax_h3_z0902", capabilityRevision: "cm-h3:2",
        }));
        expect(completed.tasks[0]).toMatchObject({ model: "studio::minimax_h3_z0902", capabilityRevision: "cm-h3:2" });

        const queryFailure = await getFilmTasks({ taskIds: ["task-running"] }, async () => {
            throw new ApiError("查询暂时失败", { status: 429, code: 429, reason: "rate_limited", retryable: true, retryAfterMs: 5000 });
        });
        expect(queryFailure.tasks[0]).toMatchObject({
            taskId: "task-running",
            status: "unknown",
            queryError: { status: 429, reason: "rate_limited", retryable: true, retryAfterMs: 5000 },
            retryAfterMs: 5000,
        });
        expect(Date.parse(String(queryFailure.tasks[0]?.nextPollAt))).toBeGreaterThan(Date.now());
        expect(queryFailure.hint).toContain("不要重新提交");
    });
});

// 四类能力各有默认模型的真实渠道目录；video 同显示名两档：
// 窄档只支持文生视频 5 秒，宽档支持参考图与 10 秒。
function modelCatalog(): AiConfig {
    const text = defaultModelCapabilityConfig(undefined, "text-one");
    const image = defaultModelCapabilityConfig(undefined, "image-one");
    const videoNarrow = defaultModelCapabilityConfig(undefined, "video-narrow");
    videoNarrow.video!.references.maxImages = 0;
    videoNarrow.video!.duration = { selection: "enum", values: [5], default: 5 };
    const videoWide = defaultModelCapabilityConfig(undefined, "video-wide");
    videoWide.video!.references.maxImages = 3;
    videoWide.video!.duration = { selection: "enum", values: [5, 10], default: 5 };
    const audio = defaultModelCapabilityConfig(undefined, "audio-one");
    const channel: ModelChannel = {
        id: "studio",
        name: "本地工作站",
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        apiFormat: "openai",
        models: ["text-one", "image-one", "video-narrow", "video-wide", "audio-one"],
        modelCosts: [
            { model: "text-one", capability: "text", capabilityConfig: text, channelModelId: "cm-text", capabilityVersion: 3 },
            { model: "image-one", capability: "image", capabilityConfig: image, channelModelId: "cm-image", capabilityVersion: 4 },
            { model: "video-narrow", displayName: "Video Pro", capability: "video", capabilityConfig: videoNarrow, channelModelId: "cm-video-narrow", capabilityVersion: 5 },
            { model: "video-wide", displayName: "Video Pro", capability: "video", capabilityConfig: videoWide, channelModelId: "cm-video-wide", capabilityVersion: 8 },
            { model: "audio-one", capability: "audio", capabilityConfig: audio, channelModelId: "cm-audio", capabilityVersion: 2 },
        ],
    };
    const value = (name: string) => encodeChannelModel(channel.id, name);
    return {
        ...defaultConfig,
        channels: [channel],
        models: channel.models.map(value),
        textModels: [value("text-one")],
        imageModels: [value("image-one")],
        videoModels: [value("video-narrow"), value("video-wide")],
        audioModels: [value("audio-one")],
        model: value("text-one"),
        textModel: value("text-one"),
        imageModel: value("image-one"),
        videoModel: value("video-narrow"),
        audioModel: value("audio-one"),
    };
}

function useCatalog(config: AiConfig) {
    useConfigStore.setState({ config });
    useUserStore.setState({ features: { ...useUserStore.getState().features, customChannelsEnabled: true } });
}
