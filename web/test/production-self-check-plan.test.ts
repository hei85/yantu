import { expect, test } from "bun:test";
import { buildFilmSelfCheckContracts } from "@/services/api/production-self-check-plan";
import type { FilmProductionPlanSpec } from "@/services/api/production-plan";
import type { ProductionStepInput } from "@/services/api/production-runs";

test("every segment and all four independent cuts remain covered", () => {
    const spec: FilmProductionPlanSpec = {version:1,targetDurationMs:10000,targetAspectRatio:"16:9",requireAudio:true,videoModels:[],sharedAssets:[1,2,3,4].map(n=>({assetId:`cut-${n}`,category:"scene",generate:false,resourceId:`image-${n}`})),storyboardRows:[{rowId:"row",durationMs:10000,sharedAssetIds:["cut-1","cut-2","cut-3","cut-4"]}]};
    const steps: ProductionStepInput[] = [
        {stepKey:"video:row:s1",kind:"video"},{stepKey:"video:row:transition",kind:"video"},
        {stepKey:"storyboard:row",kind:"check",storyboardRowId:"row"},
        {stepKey:"quality:shot:row",kind:"check",storyboardRowId:"row",dependsOn:["video:row:s1","video:row:transition"]},
        {stepKey:"continuity:row",kind:"check",storyboardRowId:"row",dependsOn:["video:row:s1","video:row:transition"]},
        {stepKey:"quality:full-film",kind:"verify"},
    ];
    const contracts = buildFilmSelfCheckContracts(spec,steps);
    expect(contracts[0].resourceIds).toEqual(["image-1","image-2","image-3","image-4"]);
    expect(contracts[1].sourceStepKeys).toEqual(["video:row:s1","video:row:transition"]);
    expect(contracts[1].requiresListening).toBe(true);
    expect(contracts[2].requiredChecks).toContain("adjacent_actual_boundary");
    expect(contracts[3].sourceStepKeys).toEqual(["timeline:master"]);
});
test("outdoors and silent films do not inherit closed-room or listening requirements", () => {
    const spec: FilmProductionPlanSpec = {version:1,targetDurationMs:1000,targetAspectRatio:"16:9",requireAudio:false,videoModels:[],storyboardRows:[]};
    const contracts = buildFilmSelfCheckContracts(spec,[{stepKey:"quality:full-film",kind:"verify"}]);
    expect(contracts[0].requiresListening).toBe(false);expect(contracts[0].requiredChecks).not.toContain("floor_plan");
});
test("continuity covers the actual previous output and a separately bound opening asset", () => {
    const spec: FilmProductionPlanSpec = {version:1,targetDurationMs:2000,targetAspectRatio:"16:9",videoModels:[],sharedAssets:[{assetId:"first.frame",category:"scene",generate:false,resourceId:"opening"}],storyboardRows:[{rowId:"previous",durationMs:1000},{rowId:"next",durationMs:1000,firstFrameAssetId:"first.frame"}]};
    const steps: ProductionStepInput[] = [{stepKey:"reuse-video:previous:s1",kind:"reuse_media",storyboardRowId:"previous"},{stepKey:"video:next:s1",kind:"video",storyboardRowId:"next"},{stepKey:"storyboard:next",kind:"check",storyboardRowId:"next"},{stepKey:"continuity:next",kind:"check",storyboardRowId:"next",dependsOn:["video:next:s1"]}];
    const contracts = buildFilmSelfCheckContracts(spec,steps);
    expect(contracts[0].resourceIds).toEqual(["opening"]);
    expect(contracts[1].sourceStepKeys).toEqual(["reuse-video:previous:s1","video:next:s1"]);
});
