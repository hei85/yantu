import {describe,expect,test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {inferredVideoResolutionNeedsVerification,videoOutputMismatchHint,VIDEO_RESOLUTION_INFERRED_HINT} from "../src/lib/video-generation-options";
import {defaultModelCapabilityConfig,type ModelCapabilityConfig} from "../src/lib/model-capabilities";
import {VideoSettingsPanel} from "../src/components/video-settings-panel";
import {canvasThemes} from "../src/lib/canvas-theme";
import {defaultConfig,normalizeConfigSnapshot} from "../src/stores/use-config-store";

function evidence(tier:string, matches=true) {
    return {feature:"resolution",verdict:matches?"supported":"observed_mismatch",source:`actual:${tier}`,details:{requestedResolution:tier,requestedRatio:"16:9",taskId:`task-${tier}`,resourceId:`res-${tier}`,outputWidth:matches?1344:768,outputHeight:matches?768:1344,fullDecodePassed:true,resolutionMatched:matches,aspectRatioMatched:matches}};
}
const profile={resolutionSource:"model-profile" as const,resolutions:["768P","2K"]};
describe("real resolution validation notices",()=>{
    test("all offered tiers need actual resource and full decode evidence",()=>{
        expect(inferredVideoResolutionNeedsVerification(profile)).toBe(true);
        expect(inferredVideoResolutionNeedsVerification(profile,[evidence("768P")])).toBe(true);
        expect(inferredVideoResolutionNeedsVerification(profile,[evidence("768P"),evidence("2K")])).toBe(false);
        const fake=evidence("2K"); fake.details.resourceId="";
        expect(inferredVideoResolutionNeedsVerification(profile,[evidence("768P"),fake])).toBe(true);
    });
    test("a negative actual test replaces untested copy with the actual mismatch",()=>{
        const observed=[evidence("768P"),evidence("2K",false)];
        expect(inferredVideoResolutionNeedsVerification(profile,observed)).toBe(false);
        expect(videoOutputMismatchHint("2K",observed)).toContain("768×1344");
        expect(videoOutputMismatchHint("2K",observed)).toContain("分辨率和画幅参数未生效");
        expect(videoOutputMismatchHint("768P",observed)).toBe("");
    });
    test("latest failed output wins over an earlier successful output",()=>{
        expect(videoOutputMismatchHint("2K",[evidence("2K"),evidence("2K",false)])).not.toBe("");
        expect(videoOutputMismatchHint("2K",[evidence("2K",false),evidence("2K")])).toBe("");
        expect(videoOutputMismatchHint("2K",[null] as never)).toBe("");
        expect(inferredVideoResolutionNeedsVerification({...profile,resolutionSource:"catalog"},null as never)).toBe(false);
    });
    test("canvas settings remove the old notice only for the actually tested model",()=>{
        const capability=defaultModelCapabilityConfig("newapi","MiniMax H3-1");
        capability.video={...capability.video!,...profile};
        capability.observed=[evidence("768P"),evidence("2K",false)] as ModelCapabilityConfig["observed"];
        const model="relay::MiniMax H3-1";
        const config=normalizeConfigSnapshot({config:{...defaultConfig,model,videoModel:model,size:"16:9",vquality:"2K",channels:[{id:"relay",name:"Relay",scope:"system",apiKey:"system",baseUrl:"/api/ai/system/relay",apiFormat:"openai",models:["MiniMax H3-1"],modelCosts:[{model:"MiniMax H3-1",protocol:"newapi",capability:"video",capabilityConfig:capability}]}]}}).config;
        const markup=renderToStaticMarkup(<VideoSettingsPanel config={config} onConfigChange={()=>{}} theme={canvasThemes.light}/>);
        expect(markup).not.toContain(VIDEO_RESOLUTION_INFERRED_HINT);
        expect(markup).toContain("768×1344");
        capability.observed=[];
        const untouched=normalizeConfigSnapshot({config:{...config,channels:[{...config.channels[0],modelCosts:[{...config.channels[0].modelCosts![0],capabilityConfig:capability}]}]}}).config;
        expect(renderToStaticMarkup(<VideoSettingsPanel config={untouched} onConfigChange={()=>{}} theme={canvasThemes.light}/>)).toContain(VIDEO_RESOLUTION_INFERRED_HINT);
    });
});
