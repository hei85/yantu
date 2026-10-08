import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoSettingsPanel } from "../src/components/video-settings-panel";
import { CanvasVideoSettingsPopover } from "../src/components/canvas/canvas-video-settings-popover";
import { CreationComposer } from "../src/pages/create/creation-workspace";
import { canvasThemes } from "../src/lib/canvas-theme";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor, normalizeVideoValue, videoResolutionRequest } from "../src/lib/model-capabilities";
import { defaultConfig, normalizeConfigSnapshot } from "../src/stores/use-config-store";

function videoConfig(resolutions: string[] | null) {
    const capabilityConfig = defaultModelCapabilityConfig("newapi", "MiniMax H3-1");
    capabilityConfig.video!.resolutions = resolutions as never;
    capabilityConfig.video!.defaultResolution = resolutions?.[0] || "";
    const model = "axon::MiniMax H3-1";
    return normalizeConfigSnapshot({ config: {
        ...defaultConfig, model, videoModel: model, size: "16:9", vquality: "1080P", videoSeconds: "5",
        channels: [{ id: "axon", name: "Axon", scope: "system", apiKey: "system", apiFormat: "openai", baseUrl: "/api/ai/system/axon", models: ["MiniMax H3-1"], modelCosts: [{ model: "MiniMax H3-1", protocol: "newapi", capability: "video", capabilityConfig }] }],
    } }).config;
}

describe("video resolution display when the channel declares no choices", () => {
    test("settings explain the channel default without manufacturing buttons or dimensions", () => {
        const config = videoConfig(null);
        const markup = renderToStaticMarkup(<VideoSettingsPanel config={config} onConfigChange={() => {}} theme={canvasThemes.light} />);
        expect(markup).toContain("分辨率");
        expect(markup).toContain("渠道默认");
        expect(markup).toContain("当前型号未提供可选档位");
        expect(markup).not.toContain("1080P");
        expect(markup).not.toContain("1920");
        const profile = modelCapabilityConfigFor(config, config.model).video!;
        expect(normalizeVideoValue(profile, { resolution: "1080P" }).resolution).toBe("");
        expect(videoResolutionRequest(profile, "1080P")).toBeUndefined();
    });

    test("canvas summary shows the channel default, ratio and duration", () => {
        const markup = renderToStaticMarkup(<CanvasVideoSettingsPopover config={videoConfig(null)} onConfigChange={() => {}} />);
        expect(markup).toContain("渠道默认分辨率 · 16:9 · 5s");
        expect(markup).not.toContain("1080P");
    });

    test("homepage composer reports the channel default for the selected model", () => {
        const config = videoConfig(null);
        const profile = modelCapabilityConfigFor(config, config.model);
        const noop = () => {};
        const markup = renderToStaticMarkup(<CreationComposer
            variant="empty" mode="video" prompt="" setPrompt={noop} busy={false} generationActive={false} referenceReplacementBusy={false}
            attachments={[]} maxReferences={9} references={[]} onRemoveAttachment={noop} onClearAttachments={noop} onClearComposer={noop}
            onReorderAttachments={noop} onReplaceAttachment={noop} onReplaceReferenceFiles={noop} onOpenLibrary={noop} onModeChange={noop}
            model={config.model} modelRequirements={{ capability: "video" }} videoProfile={profile.video!} imageProfile={profile.image!} config={config}
            onModelChange={noop} ratio="16:9" setRatio={noop} seconds="5" setSeconds={noop} quality="auto" setQuality={noop}
            videoQuality="1080P" setVideoQuality={noop} count="1" setCount={noop} textStreaming={false} setTextStreaming={noop}
            textThinking={false} setTextThinking={noop} promptOptimizerProvider={null} composerFocusRef={{ current: null }} onPromptFocus={noop} onSubmit={noop}
        />);
        expect(markup).toContain("生成设置：16:9 · 渠道默认分辨率");
    });

    test("declared resolutions keep their existing selectable controls", () => {
        const config = videoConfig(["480P", "1080P"]);
        const markup = renderToStaticMarkup(<VideoSettingsPanel config={config} onConfigChange={() => {}} theme={canvasThemes.light} />);
        expect(markup).toContain("480P");
        expect(markup).toContain("1080P");
        expect(markup).not.toContain("渠道默认");
        expect(videoResolutionRequest(modelCapabilityConfigFor(config, config.model).video!, "1080")).toBe("1080P");
    });
});
