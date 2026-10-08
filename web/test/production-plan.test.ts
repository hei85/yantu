import { describe, expect, test } from "bun:test";

import { buildFilmProductionPlan, hydrateProductionVoiceBindings, type FilmProductionPlanSpec } from "@/services/api/production-plan";

const videoModels = [
    {
        value: "video-short",
        supports: {
            capabilityRevision: "model-short:2",
            operations: ["text_to_video"],
            duration: { mode: "enum", values: [5], default: 5 },
            ratios: ["16:9"],
            resolutions: ["1080p"],
            maxReferenceImages: 0,
            maxReferenceVideos: 0,
            maxReferenceAudios: 0,
            generateAudio: false,
        },
    },
    {
        value: "video-reference",
        supports: {
            capabilityRevision: "model-reference:7",
            operations: ["text_to_video", "image_to_video"],
            duration: { mode: "enum", values: [5, 10], default: 5 },
            ratios: ["16:9"],
            resolutions: ["720p", "1080p"],
            maxReferenceImages: 3,
            maxReferenceVideos: 0,
            maxReferenceAudios: 0,
            generateAudio: false,
        },
    },
];

function baseSpec(): FilmProductionPlanSpec {
    return {
        version: 1,
        targetDurationMs: 15_000,
        targetAspectRatio: "16:9",
        targetResolution: "1080p",
        requireAudio: true,
        requireSubtitle: true,
        audioMode: "REBUILD_AUDIO",
        audioPolicy: "independent",
        videoModels,
        audioModels: [{ value: "audio-tts", supports: { capabilityRevision: "audio-channel:2", audioCapabilities: { tts: "configured", voiceDesign: "unknown", voiceReference: "unknown", music: "unknown", soundEffects: "unknown", defaultVoiceId: "alloy" } } }],
        sharedAssets: [{ assetId: "character-mira-v3", category: "character", generate: true, estimatedCostMicros: 800 }],
        storyboardRows: [
            {
                rowId: "shot-01",
                sceneId: "scene-1",
                durationMs: 10_000,
                videoOperation: "image_to_video",
                sharedAssetIds: ["character-mira-v3"],
                segments: [
                    { segmentId: "shot-01-segment-01", order: 0, durationSeconds: 5, estimatedCostMicros: 2500 },
                    { segmentId: "shot-01-segment-02", order: 1, durationSeconds: 5, estimatedCostMicros: 2500 },
                ],
                audioTracks: [{ trackId: "shot-01-dialogue", kind: "dialogue", lineId: "line-001", text: "你好", format: "wav", sampleRate: 48000, channels: 2, estimatedCostMicros: 300 }],
                subtitleText: "你好",
            },
            {
                rowId: "shot-02",
                sceneId: "scene-1",
                durationMs: 5000,
                videoOperation: "text_to_video",
                segments: [{ segmentId: "shot-02-segment-01", order: 0, durationSeconds: 5, estimatedCostMicros: 2500 }],
                subtitleText: "再見",
            },
        ],
        skillEvidence: [{ skillId: "character-scene-consistency", versionId: "v4", contentHash: "abc123", phase: "consistency" }],
        continuitySkillIds: ["character-scene-consistency"],
    };
}

function fullFilmV2Spec(): FilmProductionPlanSpec {
    const spec = baseSpec();
    const ref = (key: string) => ({
        artifactId: `artifact-${key}`,
        versionId: `version-${key}`,
        inputFingerprint: `sha256:input-${key}`,
        outputFingerprint: `sha256:output-${key}`,
    });
    return {
        ...spec,
        workflowVersion: 2,
        preproduction: {
            sourceScript: ref("source-script"),
            brief: ref("brief"),
            scriptBreakdown: ref("script-breakdown"),
            visualDesign: ref("visual-design"),
            roughStoryboard: { ...ref("rough-storyboard"), rowIds: ["shot-01", "shot-02"] },
            assetPackage: { ...ref("asset-package"), assetIds: ["character-mira-v3"] },
            soundPlan: { ...ref("sound-plan"), voiceVersionIds: [] },
            lockedStoryboard: { ...ref("locked-storyboard"), rowIds: ["shot-01", "shot-02"], durationFrames: 450 },
            pilot: { ...ref("pilot"), sampleRowIds: ["shot-01"] },
        },
    };
}

test("first-frame prompt changes invalidate only the corresponding first-frame fingerprint", () => {
    const spec = baseSpec();
    spec.storyboardRows[0].generateFirstFrame = true;
    spec.storyboardRows[0].firstFrameEstimatedCostMicros = 800;
    spec.storyboardRows[0].imageGenerationPrompt = "One open book";
    const before = buildFilmProductionPlan(spec);
    spec.storyboardRows[0].imageGenerationPrompt = "One open book; no closed duplicate";
    const after = buildFilmProductionPlan(spec);
    const key = "first-frame:shot-01";
    expect(after.steps.find((step) => step.stepKey === key)?.inputFingerprint).not.toBe(before.steps.find((step) => step.stepKey === key)?.inputFingerprint);
    expect(after.steps.find((step) => step.stepKey === "asset:character-mira-v3")?.inputFingerprint).toBe(before.steps.find((step) => step.stepKey === "asset:character-mira-v3")?.inputFingerprint);
});

describe("production plan builder", () => {
    test("finishes every generated first frame before locking the storyboard and starting a video pilot", () => {
        const spec = fullFilmV2Spec();
        spec.storyboardRows.forEach((row) => {
            row.videoOperation = "image_to_video";
            row.sharedAssetIds = ["character-mira-v3"];
            row.generateFirstFrame = true;
            row.firstFrameEstimatedCostMicros = 800;
        });
        const plan = buildFilmProductionPlan(spec);
        const byKey = new Map(plan.steps.map((step) => [step.stepKey, step]));
        for (const row of spec.storyboardRows) {
            const key = `first-frame:${row.rowId}`;
            expect(byKey.get(key)?.dependsOn).toContain("stage:asset_package");
            expect(byKey.get(key)?.dependsOn).not.toContain("stage:locked_storyboard");
            expect(byKey.get(key)?.dependsOn).not.toContain("stage:pilot");
            expect(byKey.get("stage:locked_storyboard")?.dependsOn).toContain(key);
            expect(plan.manifest.stageContracts?.find((stage) => stage.stepKey === "stage:locked_storyboard")?.dependsOn).toContain(key);
        }
    });

    test("builds a full-film stage DAG and holds non-pilot video until all acceptance gates pass", () => {
        const plan = buildFilmProductionPlan(fullFilmV2Spec());
        const byKey = new Map(plan.steps.map((step) => [step.stepKey, step]));
        const requiredStages = [
            "stage:brief", "stage:script_breakdown", "stage:visual_design", "stage:rough_storyboard",
            "stage:asset_package", "stage:sound_plan", "stage:locked_storyboard", "stage:pilot", "stage:postproduction",
        ];

        expect(requiredStages.every((key) => byKey.has(key))).toBe(true);
        expect(byKey.get("stage:visual_design")?.dependsOn).toEqual(["stage:script_breakdown"]);
        expect(byKey.get("stage:rough_storyboard")?.dependsOn).toEqual(["stage:script_breakdown"]);
        expect(byKey.get("stage:asset_package")?.dependsOn).toEqual(expect.arrayContaining(["stage:visual_design", "stage:rough_storyboard", "asset:character-mira-v3"]));
        expect(byKey.get("stage:locked_storyboard")?.dependsOn).toEqual(expect.arrayContaining(["stage:asset_package", "stage:sound_plan"]));
        expect(byKey.get("stage:pilot")?.dependsOn).toEqual(expect.arrayContaining(["stage:locked_storyboard", "stage:asset_package", "stage:sound_plan", "quality:shot:shot-01", "continuity:shot-01"]));
        expect(byKey.get("video:shot-01:shot-01-segment-01")?.dependsOn).not.toContain("stage:pilot");
        expect(byKey.get("video:shot-02:shot-02-segment-01")?.dependsOn).toEqual(expect.arrayContaining([
            "stage:asset_package", "stage:sound_plan", "stage:locked_storyboard", "stage:pilot",
        ]));
        expect(byKey.get("timeline:master")?.dependsOn).toContain("stage:pilot");
        expect(byKey.get("delivery:contract")?.dependsOn).toEqual(["stage:postproduction"]);
        expect(plan.manifest).toMatchObject({ workflowVersion: 2, pilotRowIds: ["shot-01"], lockedStoryboardRowIds: ["shot-01", "shot-02"] });
        expect(plan.manifest.stageContracts).toHaveLength(9);
    });

    test("requires versioned preproduction and an exact target-frame lock", () => {
        const missingPreproduction = { ...baseSpec(), workflowVersion: 2 } as FilmProductionPlanSpec;
        expect(() => buildFilmProductionPlan(missingPreproduction)).toThrow("必须提供 workflowVersion 2 的 preproduction");

        const wrongLock = fullFilmV2Spec();
        wrongLock.preproduction!.lockedStoryboard.durationFrames -= 1;
        expect(() => buildFilmProductionPlan(wrongLock)).toThrow("必须严格等于 Brief 目标帧数 450");
    });

    test("keeps explicit workflowVersion 1 on the resumable legacy plan", () => {
        const plan = buildFilmProductionPlan({ ...baseSpec(), workflowVersion: 1 });
        expect(plan.persistedSpec.workflowVersion).toBe(1);
        expect(plan.manifest.workflowVersion).toBeUndefined();
        expect(plan.steps.some((step) => step.stepKey.startsWith("stage:"))).toBe(false);
    });

    test("builds a dynamic multi-segment graph, shares assets once, keeps T2V still-free, and binds all tracks", () => {
        const plan = buildFilmProductionPlan(baseSpec());
        const assetSteps = plan.steps.filter((step) => step.stepKey.startsWith("asset:"));
        const videoSteps = plan.steps.filter((step) => step.kind === "video");
        const audioSteps = plan.steps.filter((step) => step.kind === "audio");

        expect(assetSteps).toHaveLength(1);
        expect(videoSteps).toHaveLength(3);
        expect(audioSteps.map((step) => step.storyboardRowId)).toEqual(["shot-01"]);
        expect(audioSteps[0].trackId).toBe("shot-01-dialogue");
        expect(plan.steps.some((step) => step.stepKey === "first-frame:shot-02")).toBe(false);
        expect(videoSteps[1].dependsOn).toContain(videoSteps[0].stepKey);
        expect(videoSteps[0].dependsOn).toContain(assetSteps[0].stepKey);
        expect(videoSteps[0].selectedStrategyId).toContain("video-reference@model-reference:7:image_to_video");
        expect(videoSteps[2].selectedStrategyId).toContain("video-short@model-short:2:text_to_video");
        expect(plan.steps.map((step) => step.stepKey)).toContain("quality:shot:shot-01");
        expect(plan.steps.map((step) => step.stepKey)).toContain("continuity:shot-01");
        expect(plan.steps.map((step) => step.stepKey)).toContain("timeline:master");
        expect(plan.steps.map((step) => step.stepKey)).toContain("quality:full-film");
        expect(plan.steps.map((step) => step.stepKey)).toContain("delivery:contract");
        expect(plan.manifest).toMatchObject({
            targetDurationMs: 15_000,
            audioMode: "REBUILD_AUDIO",
            audioPolicy: "independent",
            selectedModelsBySegment: expect.arrayContaining([
                expect.objectContaining({ storyboardRowId: "shot-01", capabilityRevision: "model-reference:7" }),
                expect.objectContaining({ storyboardRowId: "shot-02", operation: "text_to_video" }),
            ]),
            audioTrackBindings: [expect.objectContaining({ storyboardRowId: "shot-01", trackId: "shot-01-dialogue", stepKey: audioSteps[0].stepKey, rowStartMs: 0, rowDurationMs: 10_000, kind: "dialogue" })],
            timelineTracks: { audio: [expect.objectContaining({ trackId: "shot-01-dialogue", stepKey: audioSteps[0].stepKey })] },
            skillEvidence: [{ skillId: "character-scene-consistency", versionId: "v4", contentHash: "abc123", phase: "consistency" }],
        });
    });

    test("defaults to native audio mode without starting any separate audio model", () => {
        const spec = baseSpec();
        spec.audioMode = undefined;
        spec.audioPolicy = undefined;
        spec.requireAudio = false;
        spec.storyboardRows = spec.storyboardRows.map(({ audioTracks: _audioTracks, ...row }) => row);
        const plan = buildFilmProductionPlan(spec);
        expect(plan.manifest).toMatchObject({ audioMode: "NATIVE_AUDIO", audioPolicy: "native", audioStepKeys: [] });
        expect(plan.steps.some((step) => step.kind === "audio")).toBe(false);
    });

    test("native audio accepts a video model with no sound switch and requires real output probing", () => {
        const spec: FilmProductionPlanSpec = {
            version: 1, targetDurationMs: 5000, targetAspectRatio: "16:9", requireAudio: true,
            videoModels: [{ value: "h3-verified-output", supports: {
                capabilityRevision: "h3:1", operations: ["text_to_video"], duration: { mode: "enum", values: [5], default: 5 },
                ratios: ["16:9"], resolutions: ["1080p"], maxReferenceImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0,
                generateAudio: false, audioCapabilities: { nativeAudio: "observed" },
            } }],
            storyboardRows: [{ rowId: "shot-a", durationMs: 5000, videoOperation: "text_to_video", segments: [{ segmentId: "segment-a", order: 0, durationSeconds: 5, estimatedCostMicros: 1000 }] }],
        };
        const plan = buildFilmProductionPlan(spec);
        expect(plan.manifest.selectedModelsBySegment).toEqual([expect.objectContaining({ model: "h3-verified-output", generateAudio: false, nativeAudioEvidence: "observed" })]);
        expect((plan.manifest.preflight as Record<string, unknown>).nativeAudioMustProbe).toEqual([expect.objectContaining({ segmentId: "segment-a" })]);
        spec.storyboardRows[0].segments![0].generateAudio = true;
        expect(() => buildFilmProductionPlan(spec)).toThrow("没有兼容片段");
    });

    test("native audio prefers a model with a controllable sound switch when both models fit", () => {
        const spec: FilmProductionPlanSpec = {
            version: 1, targetDurationMs: 5000, targetAspectRatio: "16:9", requireAudio: true,
            videoModels: [
                { value: "silent-unknown", supports: { capabilityRevision: "silent:1", operations: ["text_to_video"], duration: { mode: "enum", values: [5] }, ratios: ["16:9"], maxReferenceImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0, generateAudio: false } },
                { value: "sound-switch", supports: { capabilityRevision: "sound:1", operations: ["text_to_video"], duration: { mode: "enum", values: [5] }, ratios: ["16:9"], maxReferenceImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0, generateAudio: true } },
            ],
            storyboardRows: [{ rowId: "shot-b", durationMs: 5000, videoOperation: "text_to_video", segments: [{ segmentId: "segment-b", order: 0, durationSeconds: 5, estimatedCostMicros: 1000 }] }],
        };
        const plan = buildFilmProductionPlan(spec);
        expect(plan.manifest.selectedModelsBySegment).toEqual([expect.objectContaining({ model: "sound-switch", generateAudio: true })]);
    });

    test("keeps multi-image H3 inputs on image_to_video when the live catalog declares support", () => {
        const spec: FilmProductionPlanSpec = {
            version: 1, targetDurationMs: 5000, targetAspectRatio: "16:9", audioPolicy: "none",
            videoModels: [{ value: "h3-multi-image", supports: {
                capabilityRevision: "h3-channel:2", operations: ["image_to_video"], duration: { mode: "enum", values: [5] },
                ratios: ["16:9"], resolutions: ["1080p"], minReferenceImages: 1, maxReferenceImages: 9,
                maxReferenceVideos: 0, maxReferenceAudios: 0,
            } }],
            storyboardRows: [{ rowId: "multi-ref", durationMs: 5000, referenceImageCount: 4,
                segments: [{ segmentId: "multi-ref-segment", order: 0, durationSeconds: 5, estimatedCostMicros: 1000 }] }],
        };

        const plan = buildFilmProductionPlan(spec);
        expect(plan.manifest.selectedModelsBySegment).toEqual([expect.objectContaining({ model: "h3-multi-image", operation: "image_to_video" })]);
    });

    test("selects different compatible models per shot from each shot's declared input needs", () => {
        const spec: FilmProductionPlanSpec = {
            version: 1, targetDurationMs: 10000, targetAspectRatio: "16:9", audioPolicy: "none",
            videoModels: [
                { value: "single-image", supports: { capabilityRevision: "single:1", operations: ["image_to_video"], duration: { mode: "enum", values: [5] }, ratios: ["16:9"], resolutions: ["1080p"], maxReferenceImages: 1, maxReferenceVideos: 0, maxReferenceAudios: 0 } },
                { value: "multi-image", supports: { capabilityRevision: "multi:1", operations: ["image_to_video"], duration: { mode: "enum", values: [5] }, ratios: ["16:9"], resolutions: ["1080p"], maxReferenceImages: 9, maxReferenceVideos: 0, maxReferenceAudios: 0 } },
            ],
            storyboardRows: [
                { rowId: "one-image", durationMs: 5000, referenceImageCount: 1, segments: [{ segmentId: "one", order: 0, durationSeconds: 5, estimatedCostMicros: 1000 }] },
                { rowId: "many-images", durationMs: 5000, referenceImageCount: 4, segments: [{ segmentId: "many", order: 0, durationSeconds: 5, estimatedCostMicros: 1000 }] },
            ],
        };

        const plan = buildFilmProductionPlan(spec);
        expect(plan.manifest.selectedModelsBySegment).toEqual(expect.arrayContaining([
            expect.objectContaining({ storyboardRowId: "one-image", model: "single-image" }),
            expect.objectContaining({ storyboardRowId: "many-images", model: "multi-image" }),
        ]));
        expect((plan.manifest.selectedModelsBySegment as Array<Record<string, unknown>>).every((item) => String(item.reason).includes("画幅") && String(item.reason).includes("时长"))).toBe(true);
    });

    test("keeps compatible catalog order when image capacity differs and makes no quality claim", () => {
        const spec: FilmProductionPlanSpec = {
            version: 1, targetDurationMs: 5000, targetAspectRatio: "16:9", audioPolicy: "none",
            videoModels: [
                { value: "catalog-first", supports: { capabilityRevision: "first:1", operations: ["image_to_video"], duration: { mode: "enum", values: [5] }, ratios: ["16:9"], resolutions: ["1080p"], minReferenceImages: 1, maxReferenceImages: 8, maxReferenceVideos: 0, maxReferenceAudios: 0 } },
                { value: "catalog-second", supports: { capabilityRevision: "second:1", operations: ["image_to_video"], duration: { mode: "enum", values: [5] }, ratios: ["16:9"], resolutions: ["1080p"], minReferenceImages: 1, maxReferenceImages: 1, maxReferenceVideos: 0, maxReferenceAudios: 0 } },
            ],
            storyboardRows: [{ rowId: "shot", durationMs: 5000, referenceImageCount: 1, segments: [{ segmentId: "segment", order: 0, durationSeconds: 5, estimatedCostMicros: 1000 }] }],
        };
        const plan = buildFilmProductionPlan(spec);
        const selected = (plan.manifest.selectedModelsBySegment as Array<Record<string, unknown>>)[0];
        expect(selected?.model).toBe("catalog-first");
        expect(String(selected?.reason)).not.toContain("容量排序");
        expect(String(selected?.reason)).not.toContain("质量");
    });

    test("rejects conflicting global, row and segment model pins", () => {
        const spec = baseSpec();
        spec.selectedVideoModel = "video-short";
        spec.storyboardRows[0].videoModel = "video-reference";
        spec.storyboardRows[0].segments![0].model = "video-reference";

        expect(() => buildFilmProductionPlan(spec)).toThrow("视频模型指定冲突：video-short、video-reference");
    });

    test("infers image operation from the explicitly pinned model's live capabilities", () => {
        const spec = baseSpec();
        spec.targetDurationMs = 5000;
        spec.selectedVideoModel = "reference-route";
        spec.videoModels = [
            { value: "reference-route", supports: { capabilityRevision: "reference:1", operations: ["reference_to_video"], duration: { mode: "enum", values: [5] }, ratios: ["16:9"], resolutions: ["1080p"], minReferenceImages: 1, maxReferenceImages: 4, maxReferenceVideos: 0, maxReferenceAudios: 0 } },
            { value: "image-route", supports: { capabilityRevision: "image:1", operations: ["image_to_video"], duration: { mode: "enum", values: [5] }, ratios: ["16:9"], resolutions: ["1080p"], minReferenceImages: 1, maxReferenceImages: 4, maxReferenceVideos: 0, maxReferenceAudios: 0 } },
        ];
        spec.storyboardRows = [spec.storyboardRows[0]];
        spec.storyboardRows[0].durationMs = 5000;
        spec.storyboardRows[0].segments = [spec.storyboardRows[0].segments![0]!];
        spec.storyboardRows[0].referenceImageCount = 2;
        delete spec.storyboardRows[0].videoOperation;
        spec.storyboardRows[0].segments![0].durationSeconds = 5;
        spec.storyboardRows[0].segments![0].capabilityRevision = "reference:1";

        const plan = buildFilmProductionPlan(spec);
        expect(plan.manifest.selectedModelsBySegment).toEqual([expect.objectContaining({ model: "reference-route", operation: "reference_to_video" })]);
    });

    test("uses an existing storyboard video as a probed segment without selecting a generation model", () => {
        const spec: FilmProductionPlanSpec = {
            version: 1,
            targetDurationMs: 5_000,
            targetAspectRatio: "16:9",
            videoModels: [],
            storyboardRows: [{
                rowId: "existing-shot",
                durationMs: 5_000,
                existingMedia: { resourceId: "resource-existing", sourceTaskId: "task-existing", sourceNodeId: "node-existing" },
            }],
        };

        const plan = buildFilmProductionPlan(spec);
        const reuseStep = plan.steps.find((step) => step.kind === "reuse_media");

        expect(reuseStep).toMatchObject({ storyboardRowId: "existing-shot", segmentId: expect.stringMatching(/^existing-/) });
        expect(plan.steps.some((step) => step.kind === "video")).toBe(false);
        expect(plan.manifest).toMatchObject({
            videoStepKeys: [reuseStep?.stepKey],
            selectedModelsBySegment: [],
            reusedMediaBindings: [{
                storyboardRowId: "existing-shot", stepKey: reuseStep?.stepKey, resourceId: "resource-existing",
                sourceTaskId: "task-existing", sourceNodeId: "node-existing",
            }],
            timelineSpans: [{ storyboardRowId: "existing-shot", segmentId: reuseStep?.segmentId, startFrame: 0, durationFrames: 150 }],
        });
    });

    test("derives reusable segment media only from complete successful StoryboardRow bindings", () => {
        const spec: FilmProductionPlanSpec = {
            version: 1,
            targetDurationMs: 5_000,
            targetAspectRatio: "16:9",
            videoModels: [],
            storyboardRows: [{
                rowId: "row-with-bound-video",
                durationMs: 5_000,
                videoNodeId: "video-node-1",
                segmentBindings: [{
                    segmentId: "segment-1", order: 0, videoNodeId: "video-node-1", taskId: "task-1", resourceId: "resource-1",
                    status: "succeeded", requestedDurationSeconds: 5, timelineDurationMs: 5_000,
                }],
            }],
        };

        const plan = buildFilmProductionPlan(spec);
        expect(plan.manifest.reusedMediaBindings).toEqual([
            expect.objectContaining({ storyboardRowId: "row-with-bound-video", segmentId: "segment-1", resourceId: "resource-1", sourceTaskId: "task-1", sourceNodeId: "video-node-1" }),
        ]);
        expect(() => buildFilmProductionPlan({
            ...spec,
            storyboardRows: [{ ...spec.storyboardRows[0]!, segmentBindings: [{ segmentId: "segment-1", order: 0, status: "succeeded" }] }],
        })).toThrow("成功节点和资源完整回读");
    });

    test("keeps ordered generated and reused segments in the same row timeline", () => {
        const spec = baseSpec();
        spec.targetDurationMs = 10_000;
        spec.requireAudio = false;
        spec.requireSubtitle = false;
        spec.audioMode = "NATIVE_AUDIO";
        spec.audioPolicy = undefined;
        spec.storyboardRows = [{
            rowId: "mixed-shot",
            durationMs: 10_000,
            segments: [
                { segmentId: "reused-part", order: 0, durationSeconds: 5, existingMedia: { resourceId: "resource-part" } },
                { segmentId: "new-part", order: 1, durationSeconds: 5, estimatedCostMicros: 200 },
            ],
        }];

        const plan = buildFilmProductionPlan(spec);
        const bindings = plan.manifest.reusedMediaBindings as Array<Record<string, unknown>>;

        expect(plan.steps.filter((step) => step.kind === "reuse_media")).toHaveLength(1);
        expect(plan.steps.filter((step) => step.kind === "video")).toHaveLength(1);
        expect(plan.manifest.videoStepKeys).toEqual(["reuse-video:mixed-shot:reused-part", "video:mixed-shot:new-part"]);
        expect(bindings).toEqual([expect.objectContaining({ storyboardRowId: "mixed-shot", segmentId: "reused-part", resourceId: "resource-part" })]);
        expect(plan.manifest.timelineSpans).toEqual([
            expect.objectContaining({ segmentId: "reused-part", startFrame: 0, durationFrames: 150 }),
            expect.objectContaining({ segmentId: "new-part", startFrame: 150, durationFrames: 150 }),
        ]);
        expect(plan.steps.find((step) => step.segmentId === "new-part")?.dependsOn).toContain("reuse-video:mixed-shot:reused-part");
    });

    test("legacy independent policy cannot silently opt a run into rebuilding audio", () => {
        const spec = baseSpec();
        spec.audioMode = undefined;
        expect(() => buildFilmProductionPlan(spec)).toThrow("audioMode=REBUILD_AUDIO");

        const conflict = baseSpec();
        conflict.audioMode = "NATIVE_AUDIO";
        expect(() => buildFilmProductionPlan(conflict)).toThrow("audioMode 与旧 audioPolicy 声明不一致");
    });

    test("keeps native and rebuilt dialogue mutually exclusive and records undeclared audio capabilities", () => {
        const native = baseSpec();
        native.audioMode = "NATIVE_AUDIO";
        native.audioPolicy = undefined;
        expect(() => buildFilmProductionPlan(native)).toThrow("NATIVE_AUDIO 下分镜行 shot-01 不能创建独立音频模型任务");

        const rebuild = baseSpec();
        rebuild.audioMode = "REBUILD_AUDIO";
        rebuild.audioPolicy = undefined;
        rebuild.audioModels = [{ value: "unknown-audio", supports: { capabilityRevision: "audio-channel:3", audioCapabilities: { tts: "unknown" } } }];
        const plan = buildFilmProductionPlan(rebuild);
        expect(plan.steps.some((step) => step.kind === "audio")).toBe(false);
        expect(plan.manifest.audioCapabilityGaps).toEqual([
            expect.objectContaining({
                storyboardRowId: "shot-01",
                trackId: "shot-01-dialogue",
                kind: "dialogue",
                capability: "tts",
                missingCapabilities: ["tts"],
                status: "unavailable",
                required: true,
                lineId: "line-001",
                text: "你好",
            }),
        ]);
    });

    test("rejects duplicate dialogue identity across rows and track types", () => {
        const spec = baseSpec();
        spec.storyboardRows[0].audioTracks![0].lineId = "line-001";
        spec.storyboardRows[1].audioTracks = [{ trackId: "duplicate-voiceover", kind: "voiceover", lineId: "line-001", text: "你好", estimatedCostMicros: 100 }];
        expect(() => buildFilmProductionPlan(spec)).toThrow("全片对白/旁白 lineId 重复：line-001");
    });

    test("requires stable IDs and locked text for rebuilt dialogue", () => {
        const missingId = baseSpec();
        missingId.storyboardRows[0].audioTracks![0].lineId = "";
        expect(() => buildFilmProductionPlan(missingId)).toThrow("缺少稳定 lineId");

        const missingText = baseSpec();
        missingText.storyboardRows[0].audioTracks![0].text = "   ";
        expect(() => buildFilmProductionPlan(missingText)).toThrow("缺少固定文本");
    });

    test("routes a persistent character through its pinned VoiceVersion while leaving model choice to the capability registry", () => {
        const spec = baseSpec();
        spec.storyboardRows[0].characters = [{ characterId: "character-mira", voiceVersionId: "voice-version-4" }];
        spec.storyboardRows[0].audioTracks![0].characterId = "character-mira";
        const hydrated = hydrateProductionVoiceBindings(spec, [{
            characterId: "character-mira",
            voiceVersion: {
                id: "voice-version-4", status: "ready", voiceStrategy: "standard_tts", voiceId: "alloy", speakingRate: 0.95,
                tone: "warm", emotionStyle: "steady", language: "zh-CN", accent: "standard",
            },
        }]);
        const plan = buildFilmProductionPlan(hydrated);
        expect(plan.manifest.audioTrackBindings).toEqual([
            expect.objectContaining({ characterId: "character-mira", voiceVersionId: "voice-version-4", voiceId: "alloy", voiceStrategy: "standard_tts", model: "audio-tts" }),
        ]);
        expect(plan.persistedSpec.storyboardRows[0].characters).toEqual([{ characterId: "character-mira", voiceVersionId: "voice-version-4" }]);
    });

    test("routes a standard VoiceProfile only to models listed as compatible", () => {
        const spec = baseSpec();
        spec.storyboardRows[0].characters = [{ characterId: "character-mira", voiceVersionId: "voice-version-4" }];
        spec.storyboardRows[0].audioTracks![0].characterId = "character-mira";
        spec.audioModels = [
            { value: "audio-incompatible", supports: { capabilityRevision: "audio-incompatible:1", audioCapabilities: { tts: "configured", defaultVoiceId: "alloy" } } },
            { value: "audio-compatible", supports: { capabilityRevision: "audio-compatible:2", audioCapabilities: { tts: "configured", defaultVoiceId: "alloy" } } },
        ];
        const hydrated = hydrateProductionVoiceBindings(spec, [{
            characterId: "character-mira",
            voiceProfile: { compatibleModels: ["audio-compatible"] },
            voiceVersion: { id: "voice-version-4", status: "ready", voiceStrategy: "standard_tts", voiceId: "alloy", speakingRate: 1 },
        }]);

        const plan = buildFilmProductionPlan(hydrated);
        expect(plan.manifest.audioTrackBindings).toEqual([
            expect.objectContaining({ model: "audio-compatible", capabilityRevision: "audio-compatible:2", voiceVersionId: "voice-version-4" }),
        ]);
        expect(plan.persistedSpec.storyboardRows[0].characters).toEqual([{ characterId: "character-mira", voiceVersionId: "voice-version-4" }]);
    });

    test("routes a saved Voice Design version by declared capability parameters and persists only its version reference", () => {
        const spec = baseSpec();
        spec.storyboardRows[0].characters = [{
            characterId: "character-mira", voiceVersionId: "voice-design-v3", voiceStrategy: "voice_design",
            voiceModel: "voice-design-capable", voiceCapabilityRevision: "voice-design-capable:4", voiceId: "mira-v3",
            tone: "温暖", emotionStyle: "克制坚定", speakingRate: 0.96, language: "zh-CN", accent: "普通话",
        }];
        spec.storyboardRows[0].audioTracks![0].characterId = "character-mira";
        spec.audioModels = [{ value: "voice-design-capable", supports: {
            capabilityRevision: "voice-design-capable:4",
            audioCapabilities: {
                tts: "configured", voiceDesign: "configured", voiceIdParameter: "speaker_id",
                toneParameter: "tone", emotionStyleParameter: "emotion", speakingRateParameter: "speed",
                languageParameter: "language", accentParameter: "accent", parameters: { voiceId: "speaker_id" },
            },
        } }];

        const plan = buildFilmProductionPlan(spec);
        expect(plan.manifest.audioTrackBindings).toEqual([
            expect.objectContaining({
                characterId: "character-mira", voiceVersionId: "voice-design-v3", voiceStrategy: "voice_design",
                voiceModel: "voice-design-capable", voiceId: "mira-v3", tone: "温暖", emotionStyle: "克制坚定",
                speakingRate: 0.96, language: "zh-CN", accent: "普通话",
            }),
        ]);
        expect(plan.persistedSpec.storyboardRows[0].characters).toEqual([{ characterId: "character-mira", voiceVersionId: "voice-design-v3" }]);
    });

    test("does not infer Voice Design from a model name when the registry says unknown", () => {
        const spec = baseSpec();
        spec.storyboardRows[0].characters = [{
            characterId: "character-mira", voiceVersionId: "voice-design-v3", voiceStrategy: "voice_design",
            voiceModel: "mimo-v2.5-tts-voicedesign", voiceCapabilityRevision: "mimo-channel:3", voiceId: "mira-v3",
        }];
        spec.storyboardRows[0].audioTracks![0].characterId = "character-mira";
        spec.audioModels = [{ value: "mimo-v2.5-tts-voicedesign", supports: {
            capabilityRevision: "mimo-channel:3", audioCapabilities: { tts: "configured", voiceDesign: "unknown" },
        } }];

        const plan = buildFilmProductionPlan(spec);
        expect(plan.manifest.audioTrackBindings).toEqual([]);
        expect(plan.manifest.audioCapabilityGaps).toEqual([
            expect.objectContaining({ missingCapabilities: ["voiceDesign"], status: "unavailable", voiceVersionId: "voice-design-v3" }),
        ]);
    });

    test("routes a temporary speaker to ordinary TTS without creating a persistent VoiceVersion", () => {
        const spec = baseSpec();
        spec.storyboardRows[0].audioTracks![0].characterId = "temporary-guard";
        const plan = buildFilmProductionPlan(spec);
        expect(plan.manifest.audioTrackBindings).toEqual([
            expect.objectContaining({
                characterId: "temporary-guard",
                voiceVersionId: "",
                voiceStrategy: "standard_tts",
                model: "audio-tts",
                voiceId: "alloy",
            }),
        ]);
    });

    test("requires a saved VoiceVersion for a persistent project character and does not treat it as a temporary speaker", () => {
        const spec = baseSpec();
        spec.storyboardRows[0].characters = [{ characterId: "character-mira" }];
        spec.storyboardRows[0].audioTracks![0].characterId = "character-mira";

        expect(() => hydrateProductionVoiceBindings(spec, [{ characterId: "character-mira" }])).toThrow("缺少已保存的 VoiceProfile/VoiceVersion");
        expect(() => hydrateProductionVoiceBindings(spec, [{ characterId: "character-mira" }])).toThrow("临时人物请使用独立 speaker ID");
    });

    test("routes a reference VoiceVersion without adding the model default voice ID", () => {
        const spec = baseSpec();
        spec.storyboardRows[0].characters = [{ characterId: "character-mira", voiceVersionId: "voice-reference-v2" }];
        spec.storyboardRows[0].audioTracks![0].characterId = "character-mira";
        spec.audioModels = [{ value: "reference-tts", supports: {
            capabilityRevision: "reference-audio-channel:3",
            audioCapabilities: { tts: "configured", voiceReference: "configured", defaultVoiceId: "alloy", parameters: { referenceAudio: "reference_audio" } },
        } }];
        const hydrated = hydrateProductionVoiceBindings(spec, [{
            characterId: "character-mira",
            voiceVersion: {
                id: "voice-reference-v2", status: "ready", voiceStrategy: "voice_reference", voiceModel: "reference-tts",
                capabilityRevision: "reference-audio-channel:3", referenceAudioResourceId: "voice-sample", speakingRate: 1,
            },
        }]);
        const plan = buildFilmProductionPlan(hydrated);
        expect(plan.manifest.audioTrackBindings).toEqual([
            expect.objectContaining({ voiceVersionId: "voice-reference-v2", referenceAudioResourceId: "voice-sample", voiceId: "", voiceStrategy: "voice_reference" }),
        ]);
    });

    test("records ambient, Foley and music as unavailable instead of routing them through TTS", () => {
        for (const kind of ["ambient", "sfx", "music"] as const) {
            const spec = baseSpec();
            spec.storyboardRows[0].audioTracks = [{ trackId: `track-${kind}`, kind, text: "sample", estimatedCostMicros: 100 }];
            const plan = buildFilmProductionPlan(spec);
            expect(plan.steps.some((step) => step.stepKey === `audio:shot-01:track-${kind}`)).toBe(false);
            expect(plan.manifest.audioCapabilityGaps).toEqual([
                expect.objectContaining({
                    trackId: `track-${kind}`,
                    kind,
                    capability: kind === "ambient" ? "ambientSound" : kind === "sfx" ? "soundEffects" : "music",
                    status: "unavailable",
                    required: true,
                }),
            ]);
        }
    });

    test("selects each soundtrack model by its declared purpose instead of model-name category", () => {
        const spec = baseSpec();
        spec.audioModels = [
            { value: "voice-a", supports: { capabilityRevision: "voice-a:1", audioCapabilities: { tts: "configured", defaultVoiceId: "alloy" } } },
            { value: "ambience-b", supports: { capabilityRevision: "ambience-b:1", audioCapabilities: { ambientSound: "configured" } } },
            { value: "foley-c", supports: { capabilityRevision: "foley-c:1", audioCapabilities: { soundEffects: "configured" } } },
            { value: "score-d", supports: { capabilityRevision: "score-d:1", audioCapabilities: { music: "configured" } } },
        ];
        spec.storyboardRows[0].audioTracks!.push(
            { trackId: "ambience", kind: "ambient", text: "雨声", estimatedCostMicros: 100 },
            { trackId: "foley", kind: "sfx", text: "脚步声", estimatedCostMicros: 100 },
            { trackId: "score", kind: "music", text: "舒缓配乐", estimatedCostMicros: 100 },
        );
        const plan = buildFilmProductionPlan(spec);
        expect(plan.manifest.audioTrackBindings).toEqual(expect.arrayContaining([
            expect.objectContaining({ trackId: "shot-01-dialogue", model: "voice-a" }),
            expect.objectContaining({ trackId: "ambience", model: "ambience-b" }),
            expect.objectContaining({ trackId: "foley", model: "foley-c" }),
            expect.objectContaining({ trackId: "score", model: "score-d" }),
        ]));
        expect(plan.manifest.audioCapabilityGaps).toEqual([]);
    });

    test("rejects an explicitly pinned model that cannot meet the ratio and a stale capability revision", () => {
        const explicit = baseSpec();
        explicit.selectedVideoModel = "video-short";
        expect(() => buildFilmProductionPlan(explicit)).toThrow("用户指定的视频模型 video-short");

        const stale = baseSpec();
        stale.storyboardRows[0].segments[0].capabilityRevision = "model-reference:6";
        expect(() => buildFilmProductionPlan(stale)).toThrow("能力版本已过期");
    });

    test("maps requested 720P to the model-declared 736P relay tier in the production manifest", () => {
        const spec = baseSpec();
        spec.targetResolution = "720P";
        spec.videoModels = [{
            value: "axon-h3-video",
            supports: {
                protocol: "axon-video-tasks",
                capabilityRevision: "MODEL_736:1",
                operations: ["text_to_video", "image_to_video"],
                duration: { mode: "enum", values: [5] },
                ratios: ["16:9"],
                resolutions: ["736P"],
                minReferenceImages: 0,
                maxReferenceImages: 1,
                maxReferenceVideos: 0,
                maxReferenceAudios: 0,
                generateAudio: false,
            },
        }];

        const plan = buildFilmProductionPlan(spec);

        expect(plan.manifest.targetResolution).toBe("720P");
        expect(plan.manifest.selectedModelsBySegment).toEqual(expect.arrayContaining([
            expect.objectContaining({ requestedResolution: "720P", routedResolution: "736P" }),
        ]));
    });

    test("rejects a reference-required video model for a zero-reference T2V row", () => {
        const spec: FilmProductionPlanSpec = {
            version: 1,
            targetDurationMs: 5_000,
            targetAspectRatio: "16:9",
            audioPolicy: "none",
            selectedVideoModel: "reference-only-video",
            videoModels: [{
                value: "reference-only-video",
                supports: {
                    capabilityRevision: "reference-only-video:1",
                    operations: ["text_to_video", "image_to_video"],
                    duration: { mode: "enum", values: [5] },
                    ratios: ["16:9"],
                    resolutions: ["720p"],
                    minReferenceImages: 1,
                    maxReferenceImages: 1,
                    maxReferenceVideos: 0,
                    maxReferenceAudios: 0,
                    generateAudio: false,
                },
            }],
            storyboardRows: [{
                rowId: "text-only-shot",
                durationMs: 5_000,
                videoOperation: "text_to_video",
                segments: [{ segmentId: "text-only-segment", order: 0, durationSeconds: 5, estimatedCostMicros: 100 }],
            }],
        };

        expect(() => buildFilmProductionPlan(spec)).toThrow("至少需要 1 张参考图");

        spec.storyboardRows[0]!.videoOperation = "image_to_video";
        spec.storyboardRows[0]!.firstFrameAssetId = "first-frame-asset";
        expect(() => buildFilmProductionPlan(spec)).not.toThrow();
    });

    test("rejects a 5.17 second output against a 180 second Brief and refuses zero-cost generation", () => {
        const short = baseSpec();
        short.targetDurationMs = 180_000;
        short.requireAudio = false;
        short.requireSubtitle = false;
        short.audioPolicy = "none";
        short.sharedAssets = [];
        short.storyboardRows = [{
            rowId: "shot-short",
            durationMs: 5170,
            videoOperation: "text_to_video",
            segments: [{ segmentId: "short-segment", order: 0, durationSeconds: 5.17, estimatedCostMicros: 100 }],
        }];
        short.videoModels = [{
            value: "range-video",
            supports: { capabilityRevision: "range-video:1", operations: ["text_to_video"], duration: { mode: "range", min: 1, max: 15, step: 0.01 }, ratios: ["16:9"], resolutions: ["1080p"], maxReferenceImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0, generateAudio: false },
        }];
        expect(() => buildFilmProductionPlan(short)).toThrow("Brief 目标 180000ms");

        const unknownPrice = baseSpec();
        delete unknownPrice.storyboardRows[0].segments[0].estimatedCostMicros;
        expect(() => buildFilmProductionPlan(unknownPrice)).toThrow("缺少已验证的正数费用预估");
        unknownPrice.allowUnknownPricing = true;
        unknownPrice.storyboardRows[0].segments[0].estimatedCostMicros = 0;
        expect(buildFilmProductionPlan(unknownPrice).steps.find((step) => step.stepKey === "video:shot-01:shot-01-segment-01")?.estimatedCostMicros).toBe(0);
    });

    test("allows unknown rebuild-audio pricing only under the explicit unbounded plan mode", () => {
        const bounded = baseSpec();
        bounded.storyboardRows[0].audioTracks![0].estimatedCostMicros = 0;
        expect(() => buildFilmProductionPlan(bounded)).toThrow("未知价格仅可使用已授权的无上限预算");

        const unbounded = baseSpec();
        unbounded.allowUnknownPricing = true;
        unbounded.storyboardRows[0].audioTracks![0].estimatedCostMicros = 0;
        const built = buildFilmProductionPlan(unbounded);
        expect(built.steps.find((step) => step.kind === "audio")?.estimatedCostMicros).toBe(0);
    });

    test("automatically splits a 24 second row into legal enum durations and a frame-based contiguous timeline", () => {
        const spec: FilmProductionPlanSpec = {
            version: 1,
            targetDurationMs: 24_000,
            targetFpsNumerator: 24,
            targetFpsDenominator: 1,
            targetAspectRatio: "16:9",
            audioPolicy: "none",
            videoModels: [{
                value: "enum-video",
                supports: {
                    capabilityRevision: "enum-video-channel:4",
                    operations: ["text_to_video"],
                    duration: { mode: "enum", values: [4, 8, 12], default: 12 },
                    ratios: ["16:9"],
                    resolutions: ["1080p"],
                    maxReferenceImages: 0,
                    maxReferenceVideos: 0,
                    maxReferenceAudios: 0,
                    generateAudio: false,
                },
            }],
            storyboardRows: [{
                rowId: "long-shot",
                durationMs: 24_000,
                videoOperation: "text_to_video",
                estimatedCostMicrosPerSegment: 1_500,
            }],
        };
        const plan = buildFilmProductionPlan(spec);
        const videoSteps = plan.steps.filter((step) => step.kind === "video");

        expect(videoSteps).toHaveLength(2);
        expect(videoSteps.map((step) => step.segmentOrder)).toEqual([0, 1]);
        expect(videoSteps.map((step) => step.estimatedCostMicros)).toEqual([1_500, 1_500]);
        expect(videoSteps.every((step) => step.storyboardRowId === "long-shot" && step.selectedStrategyId?.includes("enum-video-channel:4:text_to_video"))).toBe(true);
        const spans = plan.manifest.timelineSpans as Array<{ storyboardRowId: string; segmentId: string; order: number; startFrame: number; durationFrames: number; requestedDurationFrames: number }>;
        expect(spans.map(({ storyboardRowId, order, startFrame, durationFrames, requestedDurationFrames }) => ({ storyboardRowId, order, startFrame, durationFrames, requestedDurationFrames }))).toEqual([
            { storyboardRowId: "long-shot", order: 0, startFrame: 0, durationFrames: 288, requestedDurationFrames: 288 },
            { storyboardRowId: "long-shot", order: 1, startFrame: 288, durationFrames: 288, requestedDurationFrames: 288 },
        ]);
        expect(spans.every((span) => span.segmentId.startsWith("auto-"))).toBe(true);
        expect(plan.manifest.timelineTimebase).toMatchObject({ unit: "frame", fpsNumerator: 24, fpsDenominator: 1, totalFrames: 576, durationMs: 24_000 });
    });

    test("keeps the 36-by-5 sample as a regression and honors a non-even user-selected duration", () => {
        const makeSpec = (targetDurationMs: number, rowDurations: number[]): FilmProductionPlanSpec => ({
            version: 1,
            targetDurationMs,
            targetFpsNumerator: 24,
            targetFpsDenominator: 1,
            targetAspectRatio: "16:9",
            audioPolicy: "none",
            videoModels: [{
                value: "flexible-t2v",
                supports: {
                    capabilityRevision: "flexible-t2v:1",
                    operations: ["text_to_video"],
                    duration: { mode: "range", min: 1, max: 15, step: 0.01 },
                    ratios: ["16:9"],
                    resolutions: ["736P"],
                    maxReferenceImages: 0,
                    maxReferenceVideos: 0,
                    maxReferenceAudios: 0,
                    generateAudio: false,
                },
            }],
            storyboardRows: rowDurations.map((durationMs, index) => ({
                rowId: `shot-${String(index + 1).padStart(2, "0")}`,
                durationMs,
                videoOperation: "text_to_video",
                estimatedCostMicrosPerSegment: 100,
            })),
        });

        const screenshotSample = buildFilmProductionPlan(makeSpec(180_000, Array.from({ length: 36 }, () => 5_000)));
        expect(screenshotSample.manifest.preflight).toMatchObject({ rows: 36, segments: 36, briefDurationMs: 180_000 });
        expect(screenshotSample.manifest.timelineTimebase).toMatchObject({ totalFrames: 4_320, durationMs: 180_000 });

        const selectedDuration = buildFilmProductionPlan(makeSpec(17_250, [4_250, 6_250, 6_750]));
        const spans = selectedDuration.manifest.timelineSpans as Array<{ storyboardRowId: string; startFrame: number; durationFrames: number }>;
        expect(selectedDuration.manifest.preflight).toMatchObject({ rows: 3, segments: 3, briefDurationMs: 17_250 });
        expect(selectedDuration.manifest.timelineTimebase).toMatchObject({ totalFrames: 414, durationMs: 17_250 });
        expect(spans.map((span) => [span.storyboardRowId, span.startFrame, span.durationFrames])).toEqual([
            ["shot-01", 0, 102],
            ["shot-02", 102, 150],
            ["shot-03", 252, 162],
        ]);
    });
});
