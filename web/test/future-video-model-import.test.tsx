import {describe,expect,test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {mergeFetchedChannelModelCosts,sanitizeChannelModelCatalogItem} from "../src/lib/channel-model-catalog";
import {createModelChannel as createBaseModelChannel,defaultConfig,normalizeConfigSnapshot} from "../src/stores/use-config-store";
import {defaultModelCapabilityConfig} from "../src/lib/model-capabilities";
import {VideoSettingsPanel} from "../src/components/video-settings-panel";
import {canvasThemes} from "../src/lib/canvas-theme";

// Exercise imported model metadata inside the published system-channel boundary.
const createModelChannel = (channel: Parameters<typeof createBaseModelChannel>[0]) =>
    createBaseModelChannel({...channel,scope:"system",baseUrl:"/api/ai/system/relay"});

describe("future relay video model import",()=>{
    test("root specs, numeric duration and enum wrappers populate usable controls",()=>{
        const item=sanitizeChannelModelCatalogItem({id:"future-video",model_type:"video",supported_endpoint_types:["openai-video"],defaultParameters:{ratio:"9:16",seconds:10,resolution:"1080P"},supportedAspectRatios:{enum:["16:9","9:16",null]},supportedDurations:[5,10],supportedResolutions:["720P","1080P"]})!;
        const channel=createModelChannel({id:"relay",apiFormat:"openai",interfaceType:"chat-completion"});
        const costs=mergeFetchedChannelModelCosts(channel,[item]);
        expect(costs[0]?.capabilityConfig?.video).toMatchObject({ratios:["16:9","9:16"],defaultRatio:"9:16",resolutions:["720P","1080P"],defaultResolution:"1080P",duration:{selection:"enum",values:[5,10],default:10}});
        const config=normalizeConfigSnapshot({config:{...defaultConfig,model:"relay::future-video",vquality:"1080P",size:"9:16",channels:[{...channel,models:["future-video"],modelCosts:costs}]}}).config;
        const markup=renderToStaticMarkup(<VideoSettingsPanel config={config} onConfigChange={()=>{}} theme={canvasThemes.light}/>);
        expect(markup).toContain("1080P");expect(markup).toContain("9:16");expect(markup).toContain("1920");
    });
    test("malformed optional metadata imports without a null.map crash or invented tiers",()=>{
        for (const options of [null,42,{ratios:null,resolution:[],duration:false}]) {
            const item=sanitizeChannelModelCatalogItem({id:"future-video",modelType:"video",supportedEndpointTypes:["openai-video"],defaultParameters:null,options})!;
            const channel=createModelChannel({id:"relay",interfaceType:"chat-completion"});
            const costs=mergeFetchedChannelModelCosts(channel,[item]);
            expect(costs[0]?.capabilityConfig?.video?.resolutions).toEqual([]);
            const config=normalizeConfigSnapshot({config:{...defaultConfig,model:"relay::future-video",channels:[{...channel,models:["future-video"],modelCosts:costs}]}}).config;
            expect(renderToStaticMarkup(<VideoSettingsPanel config={config} onConfigChange={()=>{}} theme={canvasThemes.light}/>)).toContain("渠道默认");
        }
    });
    test("refresh preserves manually changed choices and explicit rejections",()=>{
        const capability=defaultModelCapabilityConfig("newapi","future-video");
        capability.video!.ratios=["4:3"];capability.video!.defaultRatio="4:3";
        capability.video!.resolutions=["736P"];capability.video!.defaultResolution="736P";
        capability.video!.duration={selection:"enum",values:[7],default:7};
        const channel=createModelChannel({id:"relay",interfaceType:"newapi",models:["future-video"],modelCosts:[{model:"future-video",protocol:"newapi",capability:"video",capabilityConfig:capability}]});
        const declaration=sanitizeChannelModelCatalogItem({id:"future-video",modelType:"video",options:{resolution:["1080P"],ratios:["16:9"],seconds:[5]}})!;
        const result=mergeFetchedChannelModelCosts(channel,[declaration]);
        expect(result[0]?.capabilityConfig?.video).toMatchObject({ratios:["4:3"],resolutions:["736P"],duration:{values:[7],default:7}});
    });
    test("a provider declaration replaces an unchanged profile, never an edited profile",()=>{
        const capability=defaultModelCapabilityConfig("newapi","MiniMax H3-1");
        capability.video={...capability.video!,resolutions:["768P","2K"],defaultResolution:"768P",resolutionSource:"model-profile"};
        const channel=createModelChannel({id:"relay",interfaceType:"newapi",models:["MiniMax H3-1"],modelCosts:[{model:"MiniMax H3-1",protocol:"newapi",capability:"video",capabilityConfig:capability}]});
        const declaration=sanitizeChannelModelCatalogItem({id:"MiniMax H3-1",modelType:"video",options:{resolution:["480P"]}})!;
        expect(mergeFetchedChannelModelCosts(channel,[declaration])[0]?.capabilityConfig?.video?.resolutions).toEqual(["480P"]);
        capability.video.resolutions=["736P"];capability.video.defaultResolution="736P";
        const edited=createModelChannel({...channel,modelCosts:[{...channel.modelCosts![0],capabilityConfig:capability}]});
        expect(mergeFetchedChannelModelCosts(edited,[declaration])[0]?.capabilityConfig?.video?.resolutions).toEqual(["736P"]);
    });
});
