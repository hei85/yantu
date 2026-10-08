import { mock } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultConfig, normalizeConfigSnapshot, selectableModelsByCapability } from "../src/stores/use-config-store";
import { modelCapabilityConfigFor, normalizeVideoValue } from "../src/lib/model-capabilities";
import { resolveModelGenerationDefaults, mergedImageCapabilityConfig } from "../src/lib/model-selection";

const root = path.resolve(process.env.CANVAS_DIAGNOSTIC_DIR || ".local/model-picker-diagnostics");
mkdirSync(root, { recursive: true });
if (!process.argv[3]) throw new Error("Usage: bun scripts/reproduce-model-picker.tsx <label> <public-catalog.json>");
const catalogResponse = JSON.parse(readFileSync(process.argv[3], "utf8").replace(/^\uFEFF/, ""));
const catalog = Array.isArray(catalogResponse.channels) ? catalogResponse : catalogResponse.data;
if (!catalog || !Array.isArray(catalog.channels) || !catalog.channels.length) throw new Error("The diagnostic requires actual channel catalog data.");
const originalUseState = React.useState;
let group = "";
mock.module("react", () => ({
    ...React,
    useState: (initial: unknown) => originalUseState(initial === false ? true : initial === null ? group : initial),
}));
mock.module("antd", () => ({
    Popover: ({ content, children }: any) => <>{content}{children}</>,
    Button: ({ children }: any) => <button>{children}</button>,
    Input: () => <input />,
    Modal: ({ children }: any) => <div>{children}</div>,
}));
const { ModelPicker } = await import("../src/components/model-picker");
const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: catalog.channels } }).config;
const result = [];
const suffix = process.argv[2] || "before";
for (const capability of ["video", "image", "text", "audio"] as const) {
    for (const channel of config.channels) {
        group = JSON.stringify(["channel", channel.id]);
        try {
            const markup = renderToStaticMarkup(<ModelPicker config={config} capability={capability} value={`${channel.id}::minimax_h3_z0902`} onChange={() => {}} requirements={{ capability, input: { textCount: 1, imageCount: 0, videoCount: 0, audioCount: 0, characterCount: 0 } }} />);
            result.push({ capability, channel: channel.id, ok: true, expanded: markup.includes("is-model-list"), options: (markup.match(/data-model-picker-item/g) || []).length });
        } catch (error) {
            result.push({ capability, channel: channel.id, ok: false, stack: error instanceof Error ? error.stack : String(error) });
        }
    }
}
const selections = selectableModelsByCapability(config, "video").map((model) => {
    try {
        const profile = modelCapabilityConfigFor(config, model);
        const defaults = resolveModelGenerationDefaults(config, model, "video");
        const settings = normalizeVideoValue(profile.video!, { seconds: "2", ratio: "16:9", resolution: "480P" });
        const imageProfile = mergedImageCapabilityConfig(config, model);
        const channelId = model.split("::")[0];
        group = JSON.stringify(["channel", channelId]);
        const markup = renderToStaticMarkup(<ModelPicker config={{ ...config, videoModel: model }} capability="video" value={model} onChange={() => {}} requirements={{ capability: "video", input: { textCount: 1, imageCount: 0, videoCount: 0, audioCount: 0, characterCount: 0 }, videoSeconds: settings.seconds, videoRatio: settings.ratio, videoResolution: settings.resolution }} />);
        return { model, ok: true, defaults, settings, imageQualityCount: imageProfile.quality.values.length, expanded: markup.includes("is-model-list") };
    } catch (error) {
        return { model, ok: false, stack: error instanceof Error ? error.stack : String(error) };
    }
});
if (!selections.length) throw new Error("The diagnostic did not exercise any selectable video models.");
writeFileSync(`${root}/picker-render-${suffix}.json`, JSON.stringify({ menuRenders: result, videoSelections: selections }, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log(JSON.stringify({ videoSelections: selections.length, failures: selections.filter((item) => !item.ok), syntheticReactRendering: true, popoverInfrastructureStubbed: true }));
if (result.some((item) => !item.ok) || selections.some((item) => !item.ok)) process.exitCode = 1;
