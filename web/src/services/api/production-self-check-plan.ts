import type { FilmProductionPlanSpec } from "./production-plan";
import type { ProductionStepInput } from "./production-runs";

export type FilmSelfCheckContract = {
    stepKey: string;
    resourceIds: string[];
    sourceStepKeys: string[];
    requiredChecks: string[];
    minSamples: number;
    requiresListening: boolean;
};

// Only new/explicitly upgraded plans use this contract. Old plans retain their fingerprints.
export function buildFilmSelfCheckContracts(spec: FilmProductionPlanSpec, steps: ProductionStepInput[]): FilmSelfCheckContract[] {
    const assets = spec.sharedAssets || [];
    const current = steps.filter(step => ["check", "verify"].includes(step.kind));
    return current.flatMap(step => {
        const row = spec.storyboardRows.find(item => item.rowId === step.storyboardRowId);
        const rowAssets = assets.filter(asset => row && [...(row.sharedAssetIds || []), row.firstFrameAssetId].includes(asset.assetId));
        const resources = (items: typeof assets) => items.filter(asset => !asset.generate && asset.resourceId).map(asset => asset.resourceId!);
        const sources = (items: typeof assets) => items.filter(asset => asset.generate).map(asset => `asset:${safe(asset.assetId)}`);
        const generated = (step.dependsOn || []).filter(key => steps.some(item => item.stepKey === key && ["video", "reuse_media", "render"].includes(item.kind)));
        const previousRow = row ? spec.storyboardRows[spec.storyboardRows.indexOf(row) - 1] : undefined;
        const previousVideos = previousRow ? steps.filter(item => item.storyboardRowId === previousRow.rowId && ["video", "reuse_media"].includes(item.kind)).map(item => item.stepKey) : [];
        let contract: FilmSelfCheckContract | null = null;
        if (step.stepKey === "stage:asset_package") contract = { stepKey: step.stepKey, resourceIds: resources(assets), sourceStepKeys: sources(assets), requiredChecks: ["visual_content", "reference_continuity"], minSamples: 1, requiresListening: false };
        else if (step.stepKey.startsWith("storyboard:") && row) contract = { stepKey: step.stepKey, resourceIds: resources(rowAssets), sourceStepKeys: [...sources(rowAssets), ...(step.dependsOn || []).filter(key => key.startsWith("first-frame:"))], requiredChecks: ["visual_content", "reference_continuity", "keyframe_action"], minSamples: 1, requiresListening: false };
        else if (step.stepKey.startsWith("quality:shot:")) contract = { stepKey: step.stepKey, resourceIds: [], sourceStepKeys: generated, requiredChecks: ["identity_anatomy", "space_props", "action_camera", "dialogue", "boundaries"], minSamples: 5, requiresListening: spec.requireAudio === true && spec.audioMode !== "REBUILD_AUDIO" };
        else if (step.stepKey.startsWith("continuity:")) contract = { stepKey: step.stepKey, resourceIds: [], sourceStepKeys: [...previousVideos, ...generated], requiredChecks: ["entry_exit_state", "world_positions", "prop_persistence", "adjacent_actual_boundary"], minSamples: 3, requiresListening: false };
        else if (step.stepKey === "quality:full-film") contract = { stepKey: step.stepKey, resourceIds: [], sourceStepKeys: ["timeline:master"], requiredChecks: ["story_coverage", "transition_coverage", "visual_continuity", "audio_final_mix", "subtitle_policy"], minSamples: Math.min(200, Math.max(5, spec.storyboardRows.length * 2)), requiresListening: spec.requireAudio === true };
        if (!contract) return [];
        return [{ ...contract, resourceIds: [...new Set(contract.resourceIds)], sourceStepKeys: [...new Set(contract.sourceStepKeys)] }];
    });
}
function safe(value: string) { return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, ""); }
