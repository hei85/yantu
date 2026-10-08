import { resolveVideoResolutionCapabilityValue } from "@/lib/video-generation-options";
import type { ProductionStepInput } from "./production-runs";
import { buildFilmSelfCheckContracts } from "./production-self-check-plan";

export type FilmVideoModelCapability = {
    value: string;
    supports: Record<string, unknown>;
};

export type FilmAudioModelCapability = {
    value: string;
    supports: Record<string, unknown>;
};

export type ProductionCharacterVoiceSource = {
    characterId: string;
    voiceProfile?: {
        compatibleModels?: string[];
    };
    voiceVersion?: {
        id: string;
        status: string;
        voiceStrategy: string;
        voiceModel?: string;
        capabilityRevision?: string;
        voiceId?: string;
        referenceAudioResourceId?: string;
        tone?: string;
        emotionStyle?: string;
        speakingRate: number;
        language?: string;
        accent?: string;
    };
};

export type FilmProductionArtifactReference = {
    artifactId: string;
    versionId: string;
    inputFingerprint: string;
    outputFingerprint: string;
};

export type FilmProductionPreproduction = {
    sourceScript: FilmProductionArtifactReference;
    brief: FilmProductionArtifactReference;
    scriptBreakdown: FilmProductionArtifactReference;
    visualDesign: FilmProductionArtifactReference;
    roughStoryboard: FilmProductionArtifactReference & { rowIds: string[] };
    assetPackage: FilmProductionArtifactReference & { assetIds: string[] };
    soundPlan: FilmProductionArtifactReference & { voiceVersionIds: string[] };
    lockedStoryboard: FilmProductionArtifactReference & { rowIds: string[]; durationFrames: number };
    pilot: FilmProductionArtifactReference & { sampleRowIds: string[] };
};

export type FilmProductionPlanSpec = {
    version: 1;
    /** 1/absent means an existing v1 run being resumed; every newly created full-film run must declare v2. */
    workflowVersion?: 1 | 2;
    /** Per-resource content, sampling and audio evidence. Set automatically for new full-film runs. */
    selfCheckVersion?: 1;
    /** Versioned source artifacts approved during preproduction. Required when workflowVersion is 2. */
    preproduction?: FilmProductionPreproduction;
    /** Unknown pricing is allowed only when the enclosing ProductionRun has an explicitly authorized unbounded budget. Zero remains unknown, never free. */
    allowUnknownPricing?: boolean;
    targetDurationMs: number;
    targetFpsNumerator?: number;
    targetFpsDenominator?: number;
    durationToleranceMs?: number;
    targetAspectRatio: string;
    targetResolution?: string;
    requireAudio?: boolean;
    requireSubtitle?: boolean;
    audioMode?: "NATIVE_AUDIO" | "REBUILD_AUDIO";
    audioPolicy?: "none" | "native" | "independent" | "mixed";
    selectedVideoModel?: string;
    videoModelFamily?: string;
    videoModels: FilmVideoModelCapability[];
    audioModels?: FilmAudioModelCapability[];
    sharedAssets?: Array<{
        assetId: string;
        category: "character" | "scene" | "prop" | "style";
        generate: boolean;
        inputFingerprint?: string;
        assetVersionId?: string;
        resourceId?: string;
        estimatedCostMicros?: number;
    }>;
    storyboardRows: Array<{
        rowId: string;
        sceneId?: string;
        shotId?: string;
        durationMs: number;
        videoNodeId?: string;
        segmentBindings?: Array<{
            segmentId: string;
            order: number;
            videoNodeId?: string;
            taskId?: string;
            resourceId?: string;
            status?: string;
            requestedDurationSeconds?: number;
            timelineDurationMs?: number;
        }>;
        videoModel?: string;
        videoOperation?: "text_to_video" | "image_to_video" | "reference_to_video" | "audio_to_video";
        referenceImageCount?: number;
        referenceVideoCount?: number;
        referenceAudioCount?: number;
        sharedAssetIds?: string[];
        firstFrameAssetId?: string;
        generateFirstFrame?: boolean;
        imageGenerationPrompt?: string;
        firstFrameEstimatedCostMicros?: number;
        estimatedCostMicrosPerSegment?: number;
        existingMedia?: {
            resourceId: string;
            sourceTaskId?: string;
            sourceNodeId?: string;
        };
        segments?: Array<{
            segmentId: string;
            order: number;
            durationSeconds: number;
            model?: string;
            capabilityRevision?: string;
            generateAudio?: boolean;
            estimatedCostMicros?: number;
            selectionSource?: "automatic_split";
            existingMedia?: {
                resourceId: string;
                sourceTaskId?: string;
                sourceNodeId?: string;
            };
        }>;
        characters?: Array<{
            characterId: string;
            voiceVersionId?: string;
            voiceCompatibleModels?: string[];
            voiceStrategy?: "standard_tts" | "voice_design" | "voice_reference";
            voiceModel?: string;
            voiceCapabilityRevision?: string;
            voiceId?: string;
            referenceAudioResourceId?: string;
            tone?: string;
            emotionStyle?: string;
            speakingRate?: number;
            language?: string;
            accent?: string;
        }>;
        audioTracks?: Array<{
            trackId: string;
            kind: "dialogue" | "voiceover" | "ambient" | "sfx" | "music";
            lineId?: string;
            characterId?: string;
            voiceVersionId?: string;
            text?: string;
            format?: string;
            sampleRate?: number;
            channels?: number;
            model?: string;
            capabilityRevision?: string;
            estimatedCostMicros?: number;
        }>;
        subtitleText?: string;
    }>;
    skillEvidence?: Array<{ skillId: string; versionId: string; contentHash: string; phase: string }>;
    continuitySkillIds?: string[];
};

export type BuiltFilmProductionPlan = {
    steps: ProductionStepInput[];
    manifest: Record<string, unknown>;
    persistedSpec: FilmProductionPlanSpec;
};

type ModelChoice = { model: FilmVideoModelCapability; operation: string; reason: string };

function validCostEstimate(value: number | undefined, allowUnknown: boolean) {
    return (Number.isInteger(value) && (value || 0) > 0) || (allowUnknown && (value === undefined || value === 0));
}
type VideoSegmentSpec = NonNullable<FilmProductionPlanSpec["storyboardRows"][number]["segments"]>[number];
type PlannedStoryboardRow = FilmProductionPlanSpec["storyboardRows"][number] & {
    videoOperation: string;
    segments: NonNullable<FilmProductionPlanSpec["storyboardRows"][number]["segments"]>;
};

type FilmProductionStagePlan = {
    stepKey: string;
    dependsOn: string[];
    inputFingerprint: string;
    artifactRefs: FilmProductionArtifactReference[];
    inputArtifactRefs: FilmProductionArtifactReference[];
    rowIds?: string[];
    assetIds?: string[];
    voiceVersionIds?: string[];
    sampleRowIds?: string[];
    durationFrames?: number;
    outputKind?: "timeline_master";
};

function normalizeStageArtifact(ref: FilmProductionArtifactReference | undefined, name: string): FilmProductionArtifactReference {
    if (!ref || !ref.artifactId?.trim() || !ref.versionId?.trim() || !ref.inputFingerprint?.trim() || !ref.outputFingerprint?.trim()) {
        throw new Error(`workflowVersion 2 的 preproduction.${name} 必须包含 artifactId、versionId、inputFingerprint 和 outputFingerprint`);
    }
    return {
        artifactId: ref.artifactId.trim(),
        versionId: ref.versionId.trim(),
        inputFingerprint: ref.inputFingerprint.trim(),
        outputFingerprint: ref.outputFingerprint.trim(),
    };
}

function sameOrderedIds(actual: string[] | undefined, expected: string[], label: string) {
    if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
        throw new Error(`${label} 必须与当前正式分镜行 ID 顺序完全一致`);
    }
}

function buildFullFilmStagePlan(spec: FilmProductionPlanSpec, rows: PlannedStoryboardRow[]) {
    const preproduction = spec.preproduction;
    if (!preproduction) throw new Error("新建全片必须提供 workflowVersion 2 的 preproduction 产物引用");
    const refs = {
        sourceScript: normalizeStageArtifact(preproduction.sourceScript, "sourceScript"),
        brief: normalizeStageArtifact(preproduction.brief, "brief"),
        scriptBreakdown: normalizeStageArtifact(preproduction.scriptBreakdown, "scriptBreakdown"),
        visualDesign: normalizeStageArtifact(preproduction.visualDesign, "visualDesign"),
        roughStoryboard: normalizeStageArtifact(preproduction.roughStoryboard, "roughStoryboard"),
        assetPackage: normalizeStageArtifact(preproduction.assetPackage, "assetPackage"),
        soundPlan: normalizeStageArtifact(preproduction.soundPlan, "soundPlan"),
        lockedStoryboard: normalizeStageArtifact(preproduction.lockedStoryboard, "lockedStoryboard"),
        pilot: normalizeStageArtifact(preproduction.pilot, "pilot"),
    };
    const rowIds = rows.map((row) => row.rowId.trim());
    if (rowIds.some((rowId) => !rowId) || new Set(rowIds).size !== rowIds.length) throw new Error("workflowVersion 2 的正式分镜行 ID 必须非空且唯一");
    sameOrderedIds(preproduction.roughStoryboard.rowIds, rowIds, "preproduction.roughStoryboard.rowIds");
    sameOrderedIds(preproduction.lockedStoryboard.rowIds, rowIds, "preproduction.lockedStoryboard.rowIds");

    const assetIds = (spec.sharedAssets || []).map((asset) => asset.assetId.trim());
    if (new Set(assetIds).size !== assetIds.length || assetIds.some((assetId) => !assetId)) throw new Error("全片资产 ID 必须非空且唯一");
    if (preproduction.assetPackage.assetIds.length !== assetIds.length || new Set(preproduction.assetPackage.assetIds).size !== assetIds.length || assetIds.some((assetId) => !preproduction.assetPackage.assetIds.includes(assetId))) {
        throw new Error("preproduction.assetPackage.assetIds 必须准确覆盖 productionSpec.sharedAssets");
    }
    for (const asset of spec.sharedAssets || []) {
        if (!asset.generate && (!asset.assetVersionId?.trim() || !asset.resourceId?.trim())) {
            throw new Error(`复用资产 ${asset.assetId} 必须绑定真实 assetVersionId 和 resourceId`);
        }
    }

    const voiceVersionIds = [...new Set(rows.flatMap((row) => [
        ...(row.characters || []).map((character) => character.voiceVersionId || ""),
        ...(row.audioTracks || []).map((track) => track.voiceVersionId || ""),
    ]).filter(Boolean))].sort();
    const suppliedVoiceVersionIds = [...preproduction.soundPlan.voiceVersionIds].sort();
    if (new Set(preproduction.soundPlan.voiceVersionIds).size !== preproduction.soundPlan.voiceVersionIds.length
        || suppliedVoiceVersionIds.length !== voiceVersionIds.length
        || suppliedVoiceVersionIds.some((value, index) => value !== voiceVersionIds[index])) {
        throw new Error("preproduction.soundPlan.voiceVersionIds 必须准确覆盖分镜绑定的 VoiceVersion");
    }

    const sampleRowIds = preproduction.pilot.sampleRowIds.map((rowId) => rowId.trim());
    if (!sampleRowIds.length || new Set(sampleRowIds).size !== sampleRowIds.length || sampleRowIds.some((rowId) => !rowIds.includes(rowId))) {
        throw new Error("preproduction.pilot.sampleRowIds 必须选择一个或多个当前分镜行，且不得重复");
    }
    const fpsNumerator = positiveInteger(spec.targetFpsNumerator, 30);
    const fpsDenominator = positiveInteger(spec.targetFpsDenominator, 1);
    const targetFrames = Math.round(spec.targetDurationMs * fpsNumerator / (1000 * fpsDenominator));
    if (!Number.isInteger(preproduction.lockedStoryboard.durationFrames) || preproduction.lockedStoryboard.durationFrames !== targetFrames) {
        throw new Error(`preproduction.lockedStoryboard.durationFrames 必须严格等于 Brief 目标帧数 ${targetFrames}`);
    }

    const stage = (
        stepKey: string,
        dependsOn: string[],
        artifactRefs: FilmProductionArtifactReference[],
        inputArtifactRefs: FilmProductionArtifactReference[],
        details: Partial<FilmProductionStagePlan> = {},
    ): FilmProductionStagePlan => ({
        stepKey,
        dependsOn,
        artifactRefs,
        inputArtifactRefs,
        ...details,
        inputFingerprint: fingerprint({ workflowVersion: 2, stepKey, dependsOn, artifactRefs, inputArtifactRefs, ...details }),
    });
    const stages: FilmProductionStagePlan[] = [
        stage("stage:brief", [], [refs.brief], [refs.sourceScript]),
        stage("stage:script_breakdown", ["stage:brief"], [refs.scriptBreakdown], [refs.brief]),
        stage("stage:visual_design", ["stage:script_breakdown"], [refs.visualDesign], [refs.scriptBreakdown]),
        stage("stage:rough_storyboard", ["stage:script_breakdown"], [refs.roughStoryboard], [refs.scriptBreakdown], { rowIds }),
        stage("stage:asset_package", ["stage:visual_design", "stage:rough_storyboard"], [refs.assetPackage], [refs.visualDesign, refs.roughStoryboard], { assetIds }),
        stage("stage:sound_plan", ["stage:script_breakdown", "stage:visual_design", "stage:rough_storyboard"], [refs.soundPlan], [refs.scriptBreakdown, refs.visualDesign, refs.roughStoryboard], { voiceVersionIds: preproduction.soundPlan.voiceVersionIds }),
        stage("stage:locked_storyboard", ["stage:rough_storyboard", "stage:asset_package", "stage:sound_plan"], [refs.lockedStoryboard], [refs.roughStoryboard, refs.assetPackage, refs.soundPlan], { rowIds, durationFrames: targetFrames }),
        stage("stage:pilot", ["stage:locked_storyboard", "stage:asset_package", "stage:sound_plan"], [refs.pilot], [refs.lockedStoryboard, refs.assetPackage, refs.soundPlan], { rowIds: sampleRowIds, sampleRowIds }),
        stage("stage:postproduction", ["timeline:master", "quality:full-film"], [], [], { outputKind: "timeline_master" }),
    ];
    return { stages, rowIds, sampleRowIds, targetFrames };
}

export function buildFilmProductionPlan(spec: FilmProductionPlanSpec): BuiltFilmProductionPlan {
    if (spec.version !== 1) throw new Error(`不支持的 productionSpec 版本：${String(spec.version)}`);
    if (!Number.isInteger(spec.targetDurationMs) || spec.targetDurationMs <= 0) throw new Error("productionSpec 必须包含正数 Brief 目标时长");
    if (!spec.targetAspectRatio.trim()) throw new Error("productionSpec 必须包含 Brief 目标画幅");
    if (!spec.storyboardRows.length) throw new Error("productionSpec 缺少分镜行");
    const audioMode = resolveAudioMode(spec);

    const tolerance = Math.max(0, Math.round(spec.durationToleranceMs || 0));
    const rowIds = new Set<string>();
    const globalSegmentIds = new Set<string>();
    const globalSpeechLineIds = new Set<string>();
    const assetById = new Map<string, NonNullable<FilmProductionPlanSpec["sharedAssets"]>[number]>();
    for (const asset of spec.sharedAssets || []) {
        if (!asset.assetId.trim() || assetById.has(asset.assetId)) throw new Error(`共享资产 ID 缺失或重复：${asset.assetId}`);
        if (asset.generate && !validCostEstimate(asset.estimatedCostMicros, Boolean(spec.allowUnknownPricing))) throw new Error(`共享资产 ${asset.assetId} 缺少已验证的正数费用预估；未知价格仅可使用已授权的无上限预算`);
        assetById.set(asset.assetId, asset);
    }

    const plannedRows: PlannedStoryboardRow[] = spec.storyboardRows.map((row) => {
        const videoOperation = row.videoOperation || inferOperation(spec, row);
        const segments = row.segments?.length
            ? row.segments.map((segment, index) => ({
                ...segment,
                existingMedia: segment.existingMedia || (row.segments?.length === 1 && index === 0 ? row.existingMedia : undefined),
            }))
            : row.segmentBindings?.length
                ? row.segmentBindings.slice().sort((left, right) => left.order - right.order).map((binding) => {
                    if (binding.status !== "succeeded" || !binding.videoNodeId?.trim() || !binding.resourceId?.trim()) {
                        throw new Error(`分镜行 ${row.rowId} 的现有 SegmentBinding 尚未以成功节点和资源完整回读；先恢复或修复绑定，不能重复生成`);
                    }
                    const durationSeconds = binding.timelineDurationMs && binding.timelineDurationMs > 0
                        ? binding.timelineDurationMs / 1000
                        : binding.requestedDurationSeconds;
                    if (!Number.isFinite(durationSeconds) || !durationSeconds || durationSeconds <= 0) {
                        throw new Error(`分镜行 ${row.rowId} 片段 ${binding.segmentId} 缺少可验证的时间线时长`);
                    }
                    return {
                        segmentId: binding.segmentId,
                        order: binding.order,
                        durationSeconds,
                        existingMedia: { resourceId: binding.resourceId, sourceTaskId: binding.taskId, sourceNodeId: binding.videoNodeId },
                    };
                })
            : row.existingMedia
                ? [{
                    segmentId: `existing-${fingerprint(row.rowId).slice(0, 16)}`,
                    order: 0,
                    durationSeconds: row.durationMs / 1000,
                    existingMedia: row.existingMedia,
                }]
                : row.videoNodeId?.trim()
                    ? (() => { throw new Error(`分镜行 ${row.rowId} 已绑定 videoNodeId，但缺少可核验的 resourceId/taskId；读取真实节点后再复用`) })()
                : splitStoryboardRow(spec, row, videoOperation);
        return { ...row, videoOperation, segments };
    });
    if (spec.workflowVersion !== undefined && spec.workflowVersion !== 1 && spec.workflowVersion !== 2) {
        throw new Error(`不支持的全片流程版本：${String(spec.workflowVersion)}`);
    }
    const workflow = spec.workflowVersion === 2 ? buildFullFilmStagePlan(spec, plannedRows) : undefined;
    if (!spec.videoModels.length && plannedRows.some((row) => row.segments.some((segment) => !segment.existingMedia))) {
        const unbound = plannedRows.flatMap((row) => row.segments.filter((segment) => !segment.existingMedia).map((segment) => `${row.rowId}/${segment.segmentId}`)).slice(0, 8);
        const suppliedBindings = spec.storyboardRows.flatMap((row) => (row.segmentBindings || []).map((binding) => `${row.rowId}/${binding.segmentId}:${binding.status || "unknown"}`)).slice(0, 8);
        throw new Error(`productionSpec 缺少 film_list_models 返回的视频能力目录；现有素材只能复用，不能生成新片段。未绑定分镜片段：${unbound.join(", ") || "none"}；已提供分镜绑定：${suppliedBindings.join(", ") || "none"}`);
    }
    if (audioMode === "NATIVE_AUDIO") {
        const rowWithIndependentTracks = plannedRows.find((row) => (row.audioTracks || []).length > 0);
        if (rowWithIndependentTracks) throw new Error(`NATIVE_AUDIO 下分镜行 ${rowWithIndependentTracks.rowId} 不能创建独立音频模型任务`);
    }

    const steps: ProductionStepInput[] = [];
    const stepKeys = new Set<string>();
    const selectedModelsBySegment: Array<Record<string, unknown>> = [];
    const videoStepKeys: string[] = [];
    const audioStepKeys: string[] = [];
    const pilotEvidenceStepKeys: string[] = [];
    const audioTrackBindings: Array<Record<string, unknown>> = [];
    const audioCapabilityGaps: Array<Record<string, unknown>> = [];
    const reusedMediaBindings: Array<Record<string, unknown>> = [];
    const subtitleCues: Array<Record<string, unknown>> = [];
    const timelineSpans: Array<Record<string, unknown>> = [];
    const generatedAssets = new Map<string, string>();
    const addStep = (step: ProductionStepInput) => {
        if (stepKeys.has(step.stepKey)) throw new Error(`计划步骤键重复：${step.stepKey}`);
        stepKeys.add(step.stepKey);
        step.dependsOn = [...new Set(step.dependsOn || [])];
        steps.push(step);
    };

    if (workflow) {
        for (const stage of workflow.stages.filter((item) => ["stage:brief", "stage:script_breakdown", "stage:visual_design", "stage:rough_storyboard", "stage:sound_plan"].includes(item.stepKey))) {
            addStep({ stepKey: stage.stepKey, kind: "check", dependsOn: stage.dependsOn, inputFingerprint: stage.inputFingerprint, selectedStrategyId: `workflow-v2:${stage.stepKey}` });
        }
    }

    for (const asset of spec.sharedAssets || []) {
        if (!asset.generate) continue;
        const key = `asset:${safeKey(asset.assetId)}`;
        generatedAssets.set(asset.assetId, key);
        addStep({ stepKey: key, kind: "image", dependsOn: workflow ? ["stage:visual_design", "stage:rough_storyboard"] : undefined, inputFingerprint: asset.inputFingerprint || fingerprint(asset), selectedStrategyId: `asset:${asset.category}`, estimatedCostMicros: asset.estimatedCostMicros });
    }

    if (workflow) {
        const assetStage = workflow.stages.find((item) => item.stepKey === "stage:asset_package")!;
        const lockedStage = workflow.stages.find((item) => item.stepKey === "stage:locked_storyboard")!;
        addStep({ stepKey: assetStage.stepKey, kind: "check", dependsOn: [...assetStage.dependsOn, ...generatedAssets.values()], inputFingerprint: assetStage.inputFingerprint, selectedStrategyId: `workflow-v2:${assetStage.stepKey}` });
        addStep({ stepKey: lockedStage.stepKey, kind: "check", dependsOn: lockedStage.dependsOn, inputFingerprint: lockedStage.inputFingerprint, selectedStrategyId: `workflow-v2:${lockedStage.stepKey}` });
    }

    let storyboardDurationMs = 0;
    let timelineCursorMs = 0;
    const allRowStepKeys: string[] = [];
    const fpsNumerator = positiveInteger(spec.targetFpsNumerator, 30);
    const fpsDenominator = positiveInteger(spec.targetFpsDenominator, 1);
    const toFrames = (durationMs: number) => Math.round(durationMs * fpsNumerator / (1000 * fpsDenominator));
    let timelineCursorFrame = 0;
    for (const row of plannedRows) {
        const rowId = row.rowId.trim();
        if (!rowId || rowIds.has(rowId)) throw new Error(`分镜行 ID 缺失或重复：${rowId}`);
        rowIds.add(rowId);
        if (!Number.isInteger(row.durationMs) || row.durationMs <= 0) throw new Error(`分镜行 ${rowId} 时长无效`);
        if (!row.segments.length) throw new Error(`分镜行 ${rowId} 缺少视频 SegmentBinding`);
        const segmentTotalMs = row.segments.reduce((sum, segment) => sum + Math.round(segment.durationSeconds * 1000), 0);
        if (Math.abs(segmentTotalMs - row.durationMs) > tolerance) throw new Error(`分镜行 ${rowId} 的片段总时长与分镜时长不符`);
        storyboardDurationMs += row.durationMs;

        const sharedDependencies = (row.sharedAssetIds || []).flatMap((assetId) => {
            const asset = assetById.get(assetId);
            if (!asset) throw new Error(`分镜行 ${rowId} 引用了未登记共享资产 ${assetId}`);
            const generated = generatedAssets.get(assetId);
            return generated ? [generated] : [];
        });
        const rowAssets = [...new Set(row.sharedAssetIds || [])];
        const videoOperation = row.videoOperation;
        const rowNeedsVideoGeneration = row.segments.some((segment) => !segment.existingMedia);
        const generatedFirstFrameKey = !rowNeedsVideoGeneration || videoOperation === "text_to_video" || row.firstFrameAssetId || !row.generateFirstFrame
            ? ""
            : `first-frame:${safeKey(rowId)}`;
        if (generatedFirstFrameKey) {
            if (!validCostEstimate(row.firstFrameEstimatedCostMicros, Boolean(spec.allowUnknownPricing))) throw new Error(`分镜行 ${rowId} 首帧缺少已验证的正数费用预估；未知价格仅可使用已授权的无上限预算`);
            // Finish all shot pictures before final storyboard association and video pilots.
            addStep({ stepKey: generatedFirstFrameKey, kind: "image", sceneId: row.sceneId, shotId: row.shotId, storyboardRowId: rowId, dependsOn: [...sharedDependencies, ...(workflow ? ["stage:asset_package", "stage:rough_storyboard"] : [])], inputFingerprint: fingerprint({ rowId, firstFrame: true, assets: rowAssets, ...(row.imageGenerationPrompt?.trim() ? { imageGenerationPrompt: row.imageGenerationPrompt.trim() } : {}) }), selectedStrategyId: "storyboard-first-frame", estimatedCostMicros: row.firstFrameEstimatedCostMicros });
            if (workflow) {
                const lockedStep = steps.find((item) => item.stepKey === "stage:locked_storyboard")!;
                lockedStep.dependsOn = [...new Set([...(lockedStep.dependsOn || []), generatedFirstFrameKey])];
                const lockedContract = workflow.stages.find((item) => item.stepKey === "stage:locked_storyboard")!;
                lockedContract.dependsOn = lockedStep.dependsOn;
            }
        }
        if (rowNeedsVideoGeneration && videoOperation === "image_to_video" && !row.firstFrameAssetId && !generatedFirstFrameKey && (row.referenceImageCount || 0) < 1 && rowAssets.length === 0) {
            throw new Error(`分镜行 ${rowId} 使用图生视频但没有真实首帧或参考图`);
        }

        const storyboardKey = `storyboard:${safeKey(rowId)}`;
        addStep({ stepKey: storyboardKey, kind: "check", sceneId: row.sceneId, shotId: row.shotId, storyboardRowId: rowId, dependsOn: [...sharedDependencies, ...(workflow ? ["stage:locked_storyboard"] : [])], inputFingerprint: fingerprint({ rowId, durationMs: row.durationMs, assetIds: rowAssets }), selectedStrategyId: "storyboard-row-ready" });

        const segmentKeys: string[] = [];
        for (let index = 0; index < row.segments.length; index += 1) {
            const segment = row.segments[index];
            if (!segment.segmentId.trim() || segment.order !== index || !Number.isFinite(segment.durationSeconds) || segment.durationSeconds <= 0) {
                throw new Error(`分镜行 ${rowId} 的 SegmentBinding ID、顺序或时长无效`);
            }
            if (globalSegmentIds.has(segment.segmentId)) throw new Error(`SegmentBinding ID 必须全片唯一：${segment.segmentId}`);
            globalSegmentIds.add(segment.segmentId);
            if (!segment.existingMedia && !validCostEstimate(segment.estimatedCostMicros, Boolean(spec.allowUnknownPricing))) throw new Error(`分镜行 ${rowId} 片段 ${segment.segmentId} 缺少已验证的正数费用预估；未知价格仅可使用已授权的无上限预算`);
            if (!segment.existingMedia && audioMode === "REBUILD_AUDIO" && segment.generateAudio === true) throw new Error(`REBUILD_AUDIO 禁止片段 ${segment.segmentId} 生成视频原生音轨`);
            const dependencies = [storyboardKey, ...sharedDependencies];
            if (workflow) dependencies.push("stage:asset_package", "stage:sound_plan", "stage:locked_storyboard");
            if (workflow && !workflow.sampleRowIds.includes(rowId)) dependencies.push("stage:pilot");
            if (generatedFirstFrameKey) dependencies.push(generatedFirstFrameKey);
            if (index > 0) dependencies.push(segmentKeys[index - 1]);
            if (segment.existingMedia) {
                const media = segment.existingMedia;
                const resourceId = media.resourceId.trim();
                if (!resourceId || resourceId.length > 36) throw new Error(`分镜行 ${rowId} 片段 ${segment.segmentId} 缺少有效的现有视频资源 ID`);
                if (media.sourceTaskId && media.sourceTaskId.trim().length > 36) throw new Error(`分镜行 ${rowId} 片段 ${segment.segmentId} 的来源任务 ID 无效`);
                if (media.sourceNodeId && media.sourceNodeId.trim().length > 120) throw new Error(`分镜行 ${rowId} 片段 ${segment.segmentId} 的来源节点 ID 无效`);
                const key = `reuse-video:${safeKey(rowId)}:${safeKey(segment.segmentId)}`;
                addStep({ stepKey: key, kind: "reuse_media", sceneId: row.sceneId, shotId: row.shotId, storyboardRowId: rowId, segmentId: segment.segmentId, segmentOrder: segment.order, dependsOn: dependencies, inputFingerprint: fingerprint({ rowId, segmentId: segment.segmentId, durationSeconds: segment.durationSeconds, resourceId, sourceTaskId: media.sourceTaskId || "", sourceNodeId: media.sourceNodeId || "" }), selectedStrategyId: `existing-media:${resourceId}` });
                segmentKeys.push(key);
                videoStepKeys.push(key);
                reusedMediaBindings.push({ storyboardRowId: rowId, segmentId: segment.segmentId, stepKey: key, resourceId, sourceTaskId: media.sourceTaskId || "", sourceNodeId: media.sourceNodeId || "" });
                continue;
            }
            const choice = chooseVideoModel(spec, row, segment, videoOperation, audioMode);
            // An embedded audio track can exist even when the relay has no
            // generate_audio switch. Request the switch only when declared;
            // actual audio remains a per-output acceptance requirement.
            const effectiveSegment = {
                ...segment,
                generateAudio: audioMode === "NATIVE_AUDIO" && (segment.generateAudio === true || (spec.requireAudio === true && choice.model.supports.generateAudio === true)),
            };
            const key = `video:${safeKey(rowId)}:${safeKey(segment.segmentId)}`;
            const strategy = `${choice.model.value}@${String(choice.model.supports.capabilityRevision)}:${choice.operation}`;
            addStep({ stepKey: key, kind: "video", sceneId: row.sceneId, shotId: row.shotId, storyboardRowId: rowId, segmentId: segment.segmentId, segmentOrder: segment.order, dependsOn: dependencies, inputFingerprint: fingerprint({ row, segment: effectiveSegment, model: choice.model.value, capabilityRevision: choice.model.supports.capabilityRevision, operation: choice.operation }), selectedStrategyId: strategy, estimatedCostMicros: segment.estimatedCostMicros });
            segmentKeys.push(key);
            videoStepKeys.push(key);
            const supportedResolutions = Array.isArray(choice.model.supports.resolutions) ? choice.model.supports.resolutions.map(String) : [];
            selectedModelsBySegment.push({ storyboardRowId: rowId, segmentId: segment.segmentId, order: segment.order, model: choice.model.value, capabilityRevision: choice.model.supports.capabilityRevision, operation: choice.operation, requestedResolution: spec.targetResolution || "", routedResolution: spec.targetResolution ? resolveVideoResolutionCapabilityValue(spec.targetResolution, supportedResolutions) : "", generateAudio: effectiveSegment.generateAudio, supportsNativeAudio: choice.model.supports.generateAudio === true, nativeAudioEvidence: (choice.model.supports.audioCapabilities as Record<string, unknown> | undefined)?.nativeAudio || "unknown", reason: segment.selectionSource === "automatic_split" ? `${choice.reason}；分镜时长由该模型声明的时长能力自动拆分` : choice.reason });
        }
        const rowStartFrame = timelineCursorFrame;
        const rowFrameEnd = toFrames(timelineCursorMs + row.durationMs);
        const requestedSegmentFrames = row.segments.map((segment) => Math.round(segment.durationSeconds * fpsNumerator / fpsDenominator));
        const requestedTotalFrames = requestedSegmentFrames.reduce((sum, frames) => sum + frames, 0);
        const rowFrames = rowFrameEnd - rowStartFrame;
        const frameTolerance = toFrames(tolerance);
        if (Math.abs(requestedTotalFrames - rowFrames) > frameTolerance) throw new Error(`分镜行 ${rowId} 的片段帧数与行时长不符`);
        let segmentStartFrame = rowStartFrame;
        row.segments.forEach((segment, index) => {
            const requestedFrames = requestedSegmentFrames[index];
            const timelineFrames = index === row.segments.length - 1 ? rowFrameEnd - segmentStartFrame : requestedFrames;
            if (timelineFrames <= 0) throw new Error(`分镜行 ${rowId} 的片段在目标帧率下没有可用帧`);
            timelineSpans.push({ storyboardRowId: rowId, segmentId: segment.segmentId, order: segment.order, startFrame: segmentStartFrame, durationFrames: timelineFrames, requestedDurationFrames: requestedFrames });
            segmentStartFrame += timelineFrames;
        });
        timelineCursorFrame = rowFrameEnd;
        const shotQaKey = `quality:shot:${safeKey(rowId)}`;
        addStep({ stepKey: shotQaKey, kind: "check", sceneId: row.sceneId, shotId: row.shotId, storyboardRowId: rowId, dependsOn: segmentKeys, inputFingerprint: fingerprint({ rowId, segments: row.segments.map((item) => item.segmentId), assets: rowAssets }), selectedStrategyId: `shot-qc:${(spec.continuitySkillIds || []).join(",")}` });
        const continuityKey = `continuity:${safeKey(rowId)}`;
        addStep({ stepKey: continuityKey, kind: "check", sceneId: row.sceneId, shotId: row.shotId, storyboardRowId: rowId, dependsOn: [...segmentKeys, ...sharedDependencies], inputFingerprint: fingerprint({ rowId, segmentKeys, assetIds: rowAssets }), selectedStrategyId: `continuity:${(spec.continuitySkillIds || []).join(",")}` });
        allRowStepKeys.push(shotQaKey, continuityKey);
        if (workflow && workflow.sampleRowIds.includes(rowId)) pilotEvidenceStepKeys.push(shotQaKey, continuityKey);

        if (audioMode === "NATIVE_AUDIO" && (row.audioTracks || []).length > 0) throw new Error(`NATIVE_AUDIO 下分镜行 ${rowId} 不能创建独立音频模型任务`);
        const seenLines = new Set<string>();
        const rowAudioStepKeys: string[] = [];
        for (const track of row.audioTracks || []) {
            if (!track.trackId.trim()) throw new Error(`分镜行 ${rowId} 音轨缺少稳定 trackId`);
            const normalizedText = (track.text || "").trim().replace(/\s+/g, " ");
            const speechTrack = track.kind === "dialogue" || track.kind === "voiceover";
            if (speechTrack && !normalizedText) throw new Error(`对白/旁白音轨 ${track.trackId} 缺少固定文本`);
            const lineId = track.lineId?.trim() || "";
            if (speechTrack && !lineId) throw new Error(`对白/旁白音轨 ${track.trackId} 缺少稳定 lineId`);
            if (speechTrack && lineId && globalSpeechLineIds.has(lineId)) throw new Error(`全片对白/旁白 lineId 重复：${lineId}`);
            if (speechTrack && lineId) globalSpeechLineIds.add(lineId);
            const speechKey = track.lineId
                ? ["line", lineId].join("\u0000")
                : [track.characterId || "", normalizedText].join("\u0000");
            if (speechTrack && seenLines.has(speechKey)) throw new Error(`分镜行 ${rowId} 同一句对白/旁白存在重复音轨`);
            if (speechTrack) seenLines.add(speechKey);
            const voice = track.characterId ? row.characters?.find((item) => item.characterId === track.characterId) : undefined;
            const voiceVersionId = track.voiceVersionId || voice?.voiceVersionId || "";
            if (track.voiceVersionId && voice?.voiceVersionId && track.voiceVersionId !== voice.voiceVersionId) throw new Error(`音轨 ${track.trackId} 的 VoiceVersion 与分镜角色绑定不一致`);
            if (track.voiceVersionId && (!track.characterId || !voice || voice.voiceVersionId !== track.voiceVersionId)) throw new Error(`音轨 ${track.trackId} 必须通过对应 characterId 引用 StoryboardRow 中的 VoiceVersion`);
            if (voice && voice.voiceStrategy !== "standard_tts" && !voiceVersionId) throw new Error(`主要角色 ${track.characterId} 缺少固定 VoiceVersion`);
            const audioRoute = resolveAudioTrackModel(spec.audioModels || [], track, voice);
            if (!audioRoute.model) {
                audioCapabilityGaps.push({
                    storyboardRowId: rowId,
                    trackId: track.trackId,
                    kind: track.kind,
                    capability: audioRoute.requiredCapability,
                    missingCapabilities: audioRoute.missingCapabilities,
                    status: "unavailable",
                    required: true,
                    reason: audioRoute.reason,
                    ...(speechTrack ? { lineId, text: track.text || "", characterId: track.characterId || "", voiceVersionId, voiceStrategy: voice?.voiceStrategy || "standard_tts" } : {}),
                });
                continue;
            }
            const selectedAudio = audioRoute.model;
            if (!validCostEstimate(track.estimatedCostMicros, Boolean(spec.allowUnknownPricing))) throw new Error(`音轨 ${track.trackId} 缺少已验证的正数费用预估；未知价格仅可使用已授权的无上限预算`);
            const selectedTrack = { ...track, model: selectedAudio.value, capabilityRevision: String(selectedAudio.supports.capabilityRevision || "") };
            const selectedAudioCapabilities = selectedAudio.supports.audioCapabilities as Record<string, unknown>;
            const routedVoiceId = speechTrack && voice?.voiceStrategy !== "voice_reference" ? voice?.voiceId || String(selectedAudioCapabilities.defaultVoiceId || "") : "";
            const key = `audio:${safeKey(rowId)}:${safeKey(track.trackId)}`;
            addStep({ stepKey: key, kind: "audio", sceneId: row.sceneId, shotId: row.shotId, storyboardRowId: rowId, trackId: track.trackId, dependsOn: [shotQaKey, ...(workflow ? ["stage:sound_plan"] : [])], inputFingerprint: fingerprint({ ...selectedTrack, voiceVersionId }), selectedStrategyId: `${track.kind}:${selectedTrack.model}@${selectedTrack.capabilityRevision}`, estimatedCostMicros: track.estimatedCostMicros });
            audioStepKeys.push(key);
            rowAudioStepKeys.push(key);
            audioTrackBindings.push({ storyboardRowId: rowId, trackId: track.trackId, stepKey: key, rowStartMs: timelineCursorMs, rowDurationMs: row.durationMs, kind: track.kind, model: selectedTrack.model, capabilityRevision: selectedTrack.capabilityRevision, format: track.format || "", sampleRate: track.sampleRate || 0, channels: track.channels || 0, lineId: track.lineId || "", lineIdentity: speechTrack ? speechKey : "", characterId: speechTrack ? track.characterId || "" : "", voiceVersionId: speechTrack ? voiceVersionId : "", voiceStrategy: speechTrack ? voice?.voiceStrategy || "standard_tts" : "", voiceModel: speechTrack ? voice?.voiceModel || selectedTrack.model : "", voiceId: routedVoiceId, referenceAudioResourceId: speechTrack ? voice?.referenceAudioResourceId || "" : "", text: track.text || "", tone: speechTrack ? voice?.tone || "" : "", emotionStyle: speechTrack ? voice?.emotionStyle || "" : "", speakingRate: speechTrack ? voice?.speakingRate ?? 1 : undefined, language: speechTrack ? voice?.language || "" : "", accent: speechTrack ? voice?.accent || "" : "" });
            allRowStepKeys.push(key);
        }
        if (workflow && workflow.sampleRowIds.includes(rowId) && rowAudioStepKeys.length) {
            const pilotAudioQaKey = `quality:pilot-audio:${safeKey(rowId)}`;
            addStep({ stepKey: pilotAudioQaKey, kind: "check", storyboardRowId: rowId, dependsOn: rowAudioStepKeys, inputFingerprint: fingerprint({ rowId, pilotAudio: rowAudioStepKeys, soundPlan: spec.preproduction?.soundPlan }), selectedStrategyId: "pilot-audio-qc" });
            pilotEvidenceStepKeys.push(pilotAudioQaKey);
            allRowStepKeys.push(pilotAudioQaKey);
        }
        const subtitleText = row.subtitleText?.trim();
        if (subtitleText) subtitleCues.push({ storyboardRowId: rowId, startMs: timelineCursorMs, durationMs: row.durationMs, text: subtitleText });
        timelineCursorMs += row.durationMs;
    }
    if (Math.abs(storyboardDurationMs - spec.targetDurationMs) > tolerance) throw new Error(`分镜总时长 ${storyboardDurationMs}ms 与 Brief 目标 ${spec.targetDurationMs}ms 不符`);
    if (workflow && timelineCursorFrame !== workflow.targetFrames) throw new Error(`锁定分镜总帧数 ${timelineCursorFrame} 与 Brief 目标帧数 ${workflow.targetFrames} 不符`);

    if (workflow) {
        const pilotStage = workflow.stages.find((item) => item.stepKey === "stage:pilot")!;
        addStep({ stepKey: pilotStage.stepKey, kind: "check", dependsOn: [...pilotStage.dependsOn, ...pilotEvidenceStepKeys], inputFingerprint: pilotStage.inputFingerprint, selectedStrategyId: `workflow-v2:${pilotStage.stepKey}` });
    }

    const audioPolicy = audioMode === "NATIVE_AUDIO" ? "native" : "independent";
    if (audioMode === "REBUILD_AUDIO" && audioStepKeys.length === 0 && audioCapabilityGaps.length === 0) throw new Error("REBUILD_AUDIO 没有对白、旁白、音效或音乐音轨");
    // The server checks every actual segment and the final render for audio
    // streams. A missing switch is an uncertainty, not proof of silent output.
    if (spec.requireAudio && audioMode === "REBUILD_AUDIO" && audioStepKeys.length === 0 && audioCapabilityGaps.length === 0) throw new Error("Brief 要求音频，但 REBUILD_AUDIO 计划中没有独立音轨");
    if (spec.requireSubtitle && subtitleCues.length === 0) throw new Error("Brief 要求字幕，但分镜没有可渲染的字幕文本");

    const timelineKey = "timeline:master";
    addStep({ stepKey: timelineKey, kind: "render", dependsOn: [...videoStepKeys, ...audioStepKeys, ...allRowStepKeys.filter((key) => key.startsWith("continuity:") || key.startsWith("quality:shot:")), ...(workflow ? ["stage:pilot"] : [])], inputFingerprint: fingerprint({ videoStepKeys, audioStepKeys, audioCapabilityGaps, subtitleCues, targetDurationMs: spec.targetDurationMs, targetAspectRatio: spec.targetAspectRatio }), selectedStrategyId: "timeline-multitrack-v1" });
    const fullFilmQaKey = "quality:full-film";
    addStep({ stepKey: fullFilmQaKey, kind: "verify", dependsOn: [timelineKey], inputFingerprint: fingerprint({ targetDurationMs: spec.targetDurationMs, targetAspectRatio: spec.targetAspectRatio, requireAudio: spec.requireAudio, requireSubtitle: spec.requireSubtitle, audioCapabilityGaps }), selectedStrategyId: "full-decode-contract-qc" });
    if (workflow) {
        const postproductionStage = workflow.stages.find((item) => item.stepKey === "stage:postproduction")!;
        addStep({ stepKey: postproductionStage.stepKey, kind: "check", dependsOn: postproductionStage.dependsOn, inputFingerprint: postproductionStage.inputFingerprint, selectedStrategyId: `workflow-v2:${postproductionStage.stepKey}` });
    }
    addStep({ stepKey: "delivery:contract", kind: "delivery_check", dependsOn: workflow ? ["stage:postproduction"] : [fullFilmQaKey], inputFingerprint: fingerprint({ targetDurationMs: spec.targetDurationMs, targetAspectRatio: spec.targetAspectRatio }), selectedStrategyId: "brief-delivery-contract" });

    return {
        steps,
        persistedSpec: {
            ...spec,
            storyboardRows: spec.storyboardRows.map((row) => ({
                ...row,
                characters: row.characters?.map((character) => character.voiceVersionId
                    ? { characterId: character.characterId, voiceVersionId: character.voiceVersionId }
                    : character),
            })),
        },
        manifest: {
            productionSpecVersion: spec.version,
            ...(spec.selfCheckVersion === 1 ? { selfCheckVersion: 1, selfCheckContracts: buildFilmSelfCheckContracts(spec, steps) } : {}),
            ...(workflow ? {
                workflowVersion: 2,
                stageContracts: workflow.stages.map((stage) => ({
                    ...stage,
                    dependsOn: steps.find((item) => item.stepKey === stage.stepKey)?.dependsOn || stage.dependsOn,
                })),
                pilotRowIds: workflow.sampleRowIds,
                lockedStoryboardRowIds: workflow.rowIds,
            } : {}),
            targetDurationMs: spec.targetDurationMs,
            targetFpsNumerator: fpsNumerator,
            targetFpsDenominator: fpsDenominator,
            targetAspectRatio: spec.targetAspectRatio,
            targetResolution: spec.targetResolution || "",
            videoModelFamily: spec.videoModelFamily || "",
            audioMode,
            audioPolicy,
            requireAudio: Boolean(spec.requireAudio),
            requireSubtitle: Boolean(spec.requireSubtitle),
            sharedAssetStepKeys: [...generatedAssets.values()],
            selectedModelsBySegment,
            rowAssetBindings: plannedRows.map((row) => ({ storyboardRowId: row.rowId, sharedAssetIds: row.sharedAssetIds || [], firstFrameAssetId: row.firstFrameAssetId || "", segmentIds: row.segments.map((segment) => segment.segmentId) })),
            reusedMediaBindings,
            videoStepKeys,
            audioStepKeys,
            audioTrackBindings,
            audioCapabilityGaps,
            subtitleCues,
            timelineTracks: { video: videoStepKeys, audio: audioTrackBindings, subtitle: subtitleCues },
            timelineSpans,
            timelineTimebase: { unit: "frame", fpsNumerator, fpsDenominator, totalFrames: timelineCursorFrame, durationMs: Math.round(timelineCursorFrame * 1000 * fpsDenominator / fpsNumerator) },
            skillEvidence: spec.skillEvidence || [],
            preflight: { storyboardDurationMs, briefDurationMs: spec.targetDurationMs, durationToleranceMs: tolerance, rows: plannedRows.length, segments: videoStepKeys.length, audioCapabilityGaps: audioCapabilityGaps.length, nativeAudioMustProbe: audioMode === "NATIVE_AUDIO" && spec.requireAudio === true ? selectedModelsBySegment.filter((item) => item.generateAudio !== true).map((item) => ({ storyboardRowId: item.storyboardRowId, segmentId: item.segmentId, model: item.model })) : [] },
        },
    };
}

function splitStoryboardRow(spec: FilmProductionPlanSpec, row: FilmProductionPlanSpec["storyboardRows"][number], operation: string) {
    if (!validCostEstimate(row.estimatedCostMicrosPerSegment, Boolean(spec.allowUnknownPricing))) {
        throw new Error(`分镜行 ${row.rowId} 需要自动拆片，但缺少已验证的单次片段费用预估；未知价格仅可使用已授权的无上限预算`);
    }
    const pinnedModel = resolvePinnedVideoModel(spec, row);
    const candidates = pinnedModel ? spec.videoModels.filter((model) => model.value === pinnedModel) : [...spec.videoModels];
    if (pinnedModel && candidates.length === 0) throw new Error(`指定视频模型 ${pinnedModel} 不在当前 film_list_models 目录中`);
    const requiresAudio = resolveAudioMode(spec) === "NATIVE_AUDIO" && (spec.requireAudio === true || row.segments?.some((segment) => segment.generateAudio === true) === true);
    if (requiresAudio && !pinnedModel) candidates.sort((left, right) => nativeAudioPriority(right) - nativeAudioPriority(left));
    for (const candidate of candidates) {
        const partition = partitionVideoDurationMs(row.durationMs, candidate.supports.duration);
        if (!partition) continue;
        const revision = String(candidate.supports.capabilityRevision || "");
        try {
            chooseVideoModel(spec, row, {
                segmentId: "automatic-split-probe",
                order: 0,
                durationSeconds: partition[0] / 1000,
                model: candidate.value,
                capabilityRevision: revision,
                generateAudio: Boolean(requiresAudio && candidate.supports.generateAudio === true),
            }, operation, resolveAudioMode(spec));
        } catch {
            continue;
        }
        return partition.map((durationMs, order) => ({
            segmentId: `auto-${fingerprint(row.rowId)}-${String(order + 1).padStart(3, "0")}`,
            order,
            durationSeconds: durationMs / 1000,
            model: candidate.value,
            capabilityRevision: revision,
            generateAudio: Boolean(requiresAudio && candidate.supports.generateAudio === true),
            estimatedCostMicros: row.estimatedCostMicrosPerSegment,
            selectionSource: "automatic_split" as const,
        }));
    }
    throw new Error(pinnedModel
        ? `用户指定的视频模型 ${pinnedModel} 无法按其时长能力拆分分镜行 ${row.rowId}`
        : `没有可按模型能力拆分分镜行 ${row.rowId} 的候选；请调整时长、模型或费用预估`);
}

function supportedSegmentDurationsMs(value: unknown) {
    if (!value || typeof value !== "object") return [];
    const duration = value as Record<string, unknown>;
    if (duration.mode === "enum") {
        return Array.isArray(duration.values)
            ? [...new Set(duration.values.map((item) => Math.round(Number(item) * 1000)).filter((item) => Number.isInteger(item) && item > 0))].sort((left, right) => right - left)
            : [];
    }
    if (duration.mode !== "range") return [];
    const min = Number(duration.min);
    const max = Number(duration.max);
    const step = Number(duration.step);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) return [];
    if (!Number.isFinite(step) || step <= 0) return [Math.round(max * 1000), Math.round(min * 1000)].filter((item, index, list) => item > 0 && list.indexOf(item) === index).sort((left, right) => right - left);
    const values: number[] = [];
    for (let seconds = min; seconds <= max + 1e-9 && values.length < 20_000; seconds += step) values.push(Math.round(seconds * 1000));
    return [...new Set(values.filter((item) => item > 0))].sort((left, right) => right - left);
}

function partitionDurationMs(totalMs: number, durationsMs: number[]) {
    if (!Number.isInteger(totalMs) || totalMs <= 0 || !durationsMs.length) return undefined;
    const values = [...new Set(durationsMs)].filter((value) => Number.isInteger(value) && value > 0).sort((left, right) => right - left);
    const memo = new Map<number, number[] | null>();
    let explored = 0;
    const solve = (remainingMs: number): number[] | undefined => {
        if (remainingMs === 0) return [];
        if (remainingMs < 0) return undefined;
        if (memo.has(remainingMs)) return memo.get(remainingMs) || undefined;
        if (explored++ >= 50_000) return undefined;
        for (const durationMs of values) {
            if (durationMs > remainingMs) continue;
            const rest = solve(remainingMs - durationMs);
            if (rest && rest.length < 64) {
                const result = [durationMs, ...rest];
                memo.set(remainingMs, result);
                return result;
            }
        }
        memo.set(remainingMs, null);
        return undefined;
    };
    return solve(totalMs);
}

function partitionVideoDurationMs(totalMs: number, value: unknown) {
    if (!value || typeof value !== "object") return undefined;
    const duration = value as Record<string, unknown>;
    if (duration.mode !== "range") return partitionDurationMs(totalMs, supportedSegmentDurationsMs(value));
    const minMs = Math.round(Number(duration.min) * 1000);
    const maxMs = Math.round(Number(duration.max) * 1000);
    const step = Number(duration.step);
    if (!Number.isInteger(minMs) || !Number.isInteger(maxMs) || minMs <= 0 || maxMs < minMs) return undefined;
    if (Number.isFinite(step) && step > 0) return partitionDurationMs(totalMs, supportedSegmentDurationsMs(value));
    for (let count = Math.max(1, Math.ceil(totalMs / maxMs)); count <= 64 && count * minMs <= totalMs; count += 1) {
        const base = Math.floor(totalMs / count);
        const remainder = totalMs - base * count;
        if (base < minMs || base + (remainder ? 1 : 0) > maxMs) continue;
        return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
    }
    return undefined;
}

function positiveInteger(value: number | undefined, fallback: number) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value <= 0) throw new Error("制作帧率必须是正整数比值");
    return value;
}

function chooseVideoModel(spec: FilmProductionPlanSpec, row: FilmProductionPlanSpec["storyboardRows"][number], segment: VideoSegmentSpec, operation: string, audioMode: "NATIVE_AUDIO" | "REBUILD_AUDIO"): ModelChoice {
    const pinned = resolvePinnedVideoModel(spec, row, segment.model);
    let candidates = pinned ? spec.videoModels.filter((model) => model.value === pinned) : spec.videoModels;
    if (pinned && candidates.length === 0) throw new Error(`指定视频模型 ${pinned} 不在当前 film_list_models 目录中`);
    if (segment.capabilityRevision) {
        candidates = candidates.filter((model) => model.supports.capabilityRevision === segment.capabilityRevision);
        if (candidates.length === 0) throw new Error(`片段 ${segment.segmentId} 的视频模型能力版本已过期，请重新读取 film_list_models 并复核计划`);
    }
    const imageCount = (row.referenceImageCount || 0) + (row.sharedAssetIds?.length || 0) + (operation !== "text_to_video" && (row.firstFrameAssetId || row.generateFirstFrame) ? 1 : 0);
    const videoCount = row.referenceVideoCount || 0;
    const audioCount = row.referenceAudioCount || 0;
    const referenceImageMinimums = candidates
        .map((model) => Number(model.supports.minReferenceImages ?? 0))
        .filter((value) => Number.isInteger(value) && value >= 0);
    const minimumImagesMet = referenceImageMinimums.some((minimum) => imageCount >= minimum);
    if (referenceImageMinimums.length && !minimumImagesMet) {
        const minimumRequired = Math.min(...referenceImageMinimums);
        throw new Error(`片段 ${segment.segmentId} 至少需要 ${minimumRequired} 张参考图`);
    }
    const compatibleCandidates = candidates.filter((model) => {
        const supports = model.supports;
        if (!/^[^:]+:\d+$/.test(String(supports.capabilityRevision || "").trim())) return false;
        if (supports.durationSupported === false) return false;
        if (!Array.isArray(supports.operations) || !supports.operations.includes(operation)) return false;
        if (!durationAllowed(supports.duration, segment.durationSeconds)) return false;
        if (!Array.isArray(supports.ratios) || !supports.ratios.includes(spec.targetAspectRatio)) return false;
        if (spec.targetResolution && (!Array.isArray(supports.resolutions) || !resolveVideoResolutionCapabilityValue(spec.targetResolution, supports.resolutions.map(String)))) return false;
        const minimumReferenceImages = Number(supports.minReferenceImages ?? 0);
        if (!Number.isInteger(minimumReferenceImages) || minimumReferenceImages < 0 || imageCount < minimumReferenceImages) return false;
        if (imageCount > Number(supports.maxReferenceImages ?? 0) || videoCount > Number(supports.maxReferenceVideos ?? 0) || audioCount > Number(supports.maxReferenceAudios ?? 0)) return false;
        if (segment.generateAudio === true && supports.generateAudio !== true) return false;
        return true;
    });
    const orderedCandidates = audioMode === "NATIVE_AUDIO" && spec.requireAudio === true && segment.generateAudio !== true
        ? compatibleCandidates.slice().sort((left, right) => nativeAudioPriority(right) - nativeAudioPriority(left))
        : compatibleCandidates;
    const compatible = orderedCandidates[0];
    if (!compatible) throw new Error(pinned ? `用户指定的视频模型 ${pinned} 不满足片段 ${segment.segmentId} 的时长/画幅/输入/原生音频约束` : `没有兼容片段 ${segment.segmentId} 的视频模型，请重新查询能力目录`);
    const nativeEvidence = (compatible.supports.audioCapabilities as Record<string, unknown> | undefined)?.nativeAudio;
    const reason = pinned
        ? "显式模型锁定并通过能力校验"
        : `按${operation}输入与${imageCount}张图/${videoCount}段视频/${audioCount}段音频、${spec.targetAspectRatio}画幅、${segment.durationSeconds}s时长${spec.targetResolution ? `、${spec.targetResolution}分辨率` : ""}筛选；从能力兼容的目录候选中选择${audioMode === "NATIVE_AUDIO" && spec.requireAudio ? `；原生音频证据=${nativeEvidence === "observed" ? "已观测输出" : compatible.supports.generateAudio === true ? "存在生成开关" : "未知，需验收探测"}` : ""}`;
    return { model: compatible, operation, reason };
}

function resolvePinnedVideoModel(
    spec: FilmProductionPlanSpec,
    row: FilmProductionPlanSpec["storyboardRows"][number],
    segmentModel?: string,
) {
    const pins = [spec.selectedVideoModel, row.videoModel, segmentModel].filter((value): value is string => Boolean(value));
    const uniquePins = [...new Set(pins)];
    if (uniquePins.length > 1) {
        throw new Error(`视频模型指定冲突：${uniquePins.join("、")}；请统一全局、分镜行与片段的显式型号`);
    }
    return uniquePins[0];
}

function nativeAudioPriority(model: FilmVideoModelCapability) {
    if (model.supports.generateAudio === true) return 2;
    return (model.supports.audioCapabilities as Record<string, unknown> | undefined)?.nativeAudio === "observed" ? 1 : 0;
}

function resolveAudioMode(spec: FilmProductionPlanSpec): "NATIVE_AUDIO" | "REBUILD_AUDIO" {
    if (spec.audioPolicy === "mixed") throw new Error("音频模式必须互斥，不能使用 mixed");
    // An inferred/legacy audioPolicy is not proof that the user asked to replace
    // native sound. Rebuilding is opt-in through the run-level audioMode field.
    if (!spec.audioMode && spec.audioPolicy === "independent") {
        throw new Error("audioPolicy=independent 不能代替用户明确选择 REBUILD_AUDIO；请设置 audioMode=REBUILD_AUDIO");
    }
    const audioMode = spec.audioMode || "NATIVE_AUDIO";
    if (audioMode !== "NATIVE_AUDIO" && audioMode !== "REBUILD_AUDIO") throw new Error("audioMode 只支持 NATIVE_AUDIO 或 REBUILD_AUDIO");
    const declaredPolicyMode = spec.audioPolicy === "independent" ? "REBUILD_AUDIO" : "NATIVE_AUDIO";
    if (spec.audioMode && spec.audioPolicy && spec.audioPolicy !== "none" && audioMode !== declaredPolicyMode) throw new Error("audioMode 与旧 audioPolicy 声明不一致");
    if (spec.audioPolicy === "none" && spec.requireAudio) throw new Error("Brief 要求音频，但计划声明 audioPolicy=none");
    return audioMode;
}

type AudioTrackModelRoute = {
    model?: FilmAudioModelCapability;
    requiredCapability: string;
    missingCapabilities: string[];
    reason?: string;
};

function resolveAudioTrackModel(
    audioModels: FilmAudioModelCapability[],
    track: NonNullable<FilmProductionPlanSpec["storyboardRows"][number]["audioTracks"]>[number],
    voice?: NonNullable<FilmProductionPlanSpec["storyboardRows"][number]["characters"]>[number],
): AudioTrackModelRoute {
    const requiredCapability = track.kind === "music" ? "music" : track.kind === "sfx" ? "soundEffects" : track.kind === "ambient" ? "ambientSound" : "tts";
    const pinnedModel = voice?.voiceModel || track.model;
    let candidates = pinnedModel ? audioModels.filter((model) => model.value === pinnedModel) : audioModels;
    const profileModels = voice?.voiceCompatibleModels || [];
    if (profileModels.length > 0) candidates = candidates.filter((model) => profileModels.includes(model.value));
    const pinnedRevision = voice?.voiceCapabilityRevision || track.capabilityRevision;
    if (pinnedRevision) candidates = candidates.filter((model) => model.supports.capabilityRevision === pinnedRevision);
    const speechTrack = track.kind === "dialogue" || track.kind === "voiceover";
    const strategy = voice?.voiceStrategy || "standard_tts";
    const requiredCapabilities = [requiredCapability];
    if (speechTrack && strategy === "voice_design") requiredCapabilities.push("voiceDesign");
    if (speechTrack && strategy === "voice_reference") requiredCapabilities.push("voiceReference");
    const missingCapabilities = requiredCapabilities.filter((capability) => !candidates.some((model) => {
        const capabilities = model.supports.audioCapabilities as Record<string, unknown> | undefined;
        return capabilities?.[capability] === "configured";
    }));
    const selected = candidates.find((model) => {
        const capabilities = model.supports.audioCapabilities as Record<string, unknown> | undefined;
        if (!/^[^:]+:\d+$/.test(String(model.supports.capabilityRevision || "")) || capabilities?.[requiredCapability] !== "configured") return false;
        if (!speechTrack) return true;
        if (strategy === "voice_reference") return capabilities.voiceReference === "configured" && Boolean(voice?.voiceVersionId && voice?.referenceAudioResourceId) && Boolean(String(capabilities.parameters && (capabilities.parameters as Record<string, unknown>).referenceAudio || "").trim());
        const voiceId = String(voice?.voiceId || capabilities.defaultVoiceId || "").trim();
        if (!voiceId) return false;
        const knownVoiceIds = Array.isArray(capabilities.voiceIds) ? capabilities.voiceIds.map(String) : [];
        if (knownVoiceIds.length > 0 && !knownVoiceIds.includes(voiceId)) return false;
        const parameterMap = capabilities.parameters as Record<string, unknown> | undefined;
        if (knownVoiceIds.length === 0 && voiceId !== capabilities.defaultVoiceId && !String(parameterMap?.voiceId || "").trim()) return false;
        if (strategy === "voice_design" && (capabilities.voiceDesign !== "configured" || !voice?.voiceVersionId || !String(parameterMap?.voiceId || "").trim())) return false;
        return true;
    });
    if (!selected) {
        const target = pinnedModel ? `模型 ${pinnedModel}` : "当前能力目录";
        if (missingCapabilities.length === 0) missingCapabilities.push("compatibleVoiceRoute");
        return {
            requiredCapability,
            missingCapabilities,
            reason: `${target} 未声明 ${missingCapabilities.join(" + ")} 能力，或未声明此 VoiceVersion 所需的路由参数`,
        };
    }
    if (speechTrack && strategy !== "voice_reference") {
        const capabilities = selected.supports.audioCapabilities as Record<string, unknown>;
        const voiceId = String(voice?.voiceId || capabilities.defaultVoiceId || "").trim();
        if (!voiceId) throw new Error(`模型 ${selected.value} 没有在能力目录中配置 defaultVoiceId 或角色 voiceId`);
    }
    if ((track.kind === "dialogue" || track.kind === "voiceover") && voice?.voiceStrategy === "voice_design") {
        const capabilities = selected.supports.audioCapabilities as Record<string, unknown>;
        const parameters = capabilities.parameters as Record<string, unknown> | undefined;
        if (capabilities.voiceDesign !== "configured" || !voice.voiceVersionId || !voice.voiceId || !String(parameters?.voiceId || "").trim()) throw new Error(`角色 ${voice.characterId} 的 VoiceVersion 缺少已配置的 voice design 能力或固定 voiceId`);
    }
    if ((track.kind === "dialogue" || track.kind === "voiceover") && voice?.voiceStrategy === "voice_reference") {
        const capabilities = selected.supports.audioCapabilities as Record<string, unknown>;
        if (capabilities.voiceReference !== "configured" || !voice.voiceVersionId || !voice.referenceAudioResourceId) throw new Error(`角色 ${voice.characterId} 的 VoiceVersion 缺少已配置的参考声音能力或参考音频`);
    }
    return { model: selected, requiredCapability, missingCapabilities: [] };
}

export function hydrateProductionVoiceBindings(spec: FilmProductionPlanSpec, sources: ProductionCharacterVoiceSource[]): FilmProductionPlanSpec {
    const sourceByCharacterId = new Map(sources.map((source) => [source.characterId, source]));
    return {
        ...spec,
        storyboardRows: spec.storyboardRows.map((row) => {
            const characters = (row.characters || []).map((character) => {
                const source = sourceByCharacterId.get(character.characterId);
                const version = source?.voiceVersion;
                if (!source) return character;
                if (!version) {
                    if (character.voiceVersionId) throw new Error(`项目角色 ${character.characterId} 没有已保存的 VoiceVersion，不能使用分镜自带的临时声音绑定`);
                    return character;
                }
                const versionId = String(version.id || "");
                if (character.voiceVersionId && character.voiceVersionId !== versionId) throw new Error(`角色 ${character.characterId} 的 StoryboardRow VoiceVersion 已過期，請重新讀取角色資產`);
                if (!versionId || version.status !== "ready") throw new Error(`角色 ${character.characterId} 的 VoiceVersion 尚未可用`);
                return {
                    ...character,
                    voiceVersionId: versionId,
                    voiceCompatibleModels: source.voiceProfile?.compatibleModels?.length ? [...source.voiceProfile.compatibleModels] : undefined,
                    voiceStrategy: String(version.voiceStrategy || "standard_tts") as NonNullable<typeof character.voiceStrategy>,
                    voiceModel: String(version.voiceModel || "") || undefined,
                    voiceCapabilityRevision: String(version.capabilityRevision || "") || undefined,
                    voiceId: String(version.voiceId || "") || undefined,
                    referenceAudioResourceId: String(version.referenceAudioResourceId || "") || undefined,
                    tone: String(version.tone || "") || undefined,
                    emotionStyle: String(version.emotionStyle || "") || undefined,
                    speakingRate: Number(version.speakingRate) || 1,
                    language: String(version.language || "") || undefined,
                    accent: String(version.accent || "") || undefined,
                };
            });
            const tracks = (row.audioTracks || []).map((track) => {
                if (!track.characterId) {
                    if (track.voiceVersionId) throw new Error(`音轨 ${track.trackId} 的 VoiceVersion 必须通过 characterId 绑定角色`);
                    return track;
                }
                const source = sourceByCharacterId.get(track.characterId);
                if (source && !source.voiceVersion && (track.kind === "dialogue" || track.kind === "voiceover")) {
                    throw new Error(`项目固定角色 ${track.characterId} 缺少已保存的 VoiceProfile/VoiceVersion；临时人物请使用独立 speaker ID`);
                }
                const character = characters.find((item) => item.characterId === track.characterId);
                if (!character) {
                    if (track.voiceVersionId) throw new Error(`临时说话人 ${track.characterId} 不能引用未声明的固定 VoiceVersion`);
                    if (source && (track.kind === "dialogue" || track.kind === "voiceover")) throw new Error(`项目角色 ${track.characterId} 必须先加入 StoryboardRow 角色绑定，再引用 VoiceVersion`);
                    return track;
                }
                if (character.voiceStrategy !== "standard_tts" && !character.voiceVersionId) throw new Error(`对白/旁白角色 ${track.characterId} 未绑定可用 VoiceVersion`);
                if (track.voiceVersionId && track.voiceVersionId !== character.voiceVersionId) throw new Error(`音轨 ${track.trackId} 引用了与角色不一致的 VoiceVersion`);
                return character.voiceVersionId ? { ...track, voiceVersionId: character.voiceVersionId } : track;
            });
            return { ...row, characters, audioTracks: tracks };
        }),
    };
}

function durationAllowed(value: unknown, seconds: number) {
    if (!value || typeof value !== "object") return false;
    const duration = value as Record<string, unknown>;
    if (duration.mode === "enum") return Array.isArray(duration.values) && duration.values.some((item) => Number(item) === seconds);
    if (duration.mode !== "range") return false;
    const min = Number(duration.min);
    const max = Number(duration.max);
    const step = Number(duration.step);
    if (!Number.isFinite(min) || !Number.isFinite(max) || seconds < min || seconds > max) return false;
    return !Number.isFinite(step) || step <= 0 || Math.abs((seconds - min) / step - Math.round((seconds - min) / step)) < 1e-9;
}

function inferOperation(spec: FilmProductionPlanSpec, row: FilmProductionPlanSpec["storyboardRows"][number]) {
    const images = (row.referenceImageCount || 0) + (row.sharedAssetIds?.length || 0) + (row.firstFrameAssetId || row.generateFirstFrame ? 1 : 0);
    const videos = row.referenceVideoCount || 0;
    const audios = row.referenceAudioCount || 0;
    if (audios > 0 && images === 0 && videos === 0) return "audio_to_video";
    if (videos > 0) return "reference_to_video";
    if (images > 0) {
        // Many models accept multiple images through image_to_video. Only use
        // reference_to_video when the live catalog shows that operation is
        // the available compatible route for these inputs.
        const segmentPins = [...new Set((row.segments || []).map((segment) => segment.model).filter((value): value is string => Boolean(value)))];
        const pinnedModel = resolvePinnedVideoModel(spec, row, segmentPins[0]);
        const candidates = pinnedModel
            ? spec.videoModels.filter((model) => model.value === pinnedModel)
            : spec.videoModels;
        const supportsImages = candidates.some((model) => Array.isArray(model.supports.operations)
            && model.supports.operations.includes("image_to_video")
            && images >= Number(model.supports.minReferenceImages ?? 0)
            && images <= Number(model.supports.maxReferenceImages ?? 0));
        return supportsImages ? "image_to_video" : "reference_to_video";
    }
    if (audios > 0) return "audio_to_video";
    return "text_to_video";
}

function safeKey(value: string) {
    const key = value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!key) throw new Error("ProductionPlan 中存在无法编码的空 ID");
    return key;
}

function fingerprint(value: unknown) {
    const source = JSON.stringify(value);
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(16).padStart(8, "0");
}
