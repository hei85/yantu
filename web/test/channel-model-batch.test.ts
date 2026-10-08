import { expect, test } from "bun:test";
import { planChannelModelBatchUpdate } from "../src/lib/channel-model-batch";
import type { ModelProtocolDefinition } from "../src/lib/model-protocols";
import type { ChannelModel } from "../src/services/api/channel-models";

const protocols: ModelProtocolDefinition[] = [
    { value: "chat-completion", label: "Chat", capability: "text", create: "POST /v1/chat/completions", contentType: "application/json", media: "" },
    { value: "openai-image", label: "Image", capability: "image", create: "POST /v1/images/generations", contentType: "application/json", media: "" },
    { value: "newapi", label: "Video", capability: "video", create: "POST /v1/videos", contentType: "multipart/form-data", media: "" },
    { value: "openai-audio", label: "Audio", capability: "audio", create: "POST /v1/audio/speech", contentType: "application/json", media: "" },
];

function item(modelKey: string, capability: ChannelModel["capability"]): ChannelModel {
    return {
        id: modelKey, channelId: "channel", modelKey, providerModelKey: modelKey,
        displayName: modelKey, icon: "", capability, enabled: true,
        variants: [{ id: "v", channelModelId: modelKey, selector: { videoSeconds: "5" }, selectorKey: "v", resolution: "*", videoSeconds: 5, providerModelKey: modelKey, enabled: true, createdAt: "", updatedAt: "" }],
        createdAt: "", updatedAt: "",
    };
}

const choices = { capability: "keep" as const, protocol: "keep", status: "enable" as const };

test("batch enable fills advertised text, image and video routes", () => {
    for (const [name, capability, endpoints, want] of [
        ["go-deepseek-v4.1-flash", "text", ["openai-response", "openai"], "chat-completion"],
        ["gpt-image-2", "image", ["openai", "image-generation"], "openai-image"],
        ["minimax_h3_z0902", "video", ["openai", "openai-video"], "newapi"],
    ] as const) {
        const plan = planChannelModelBatchUpdate(item(name, capability), { id: name, supportedEndpointTypes: [...endpoints] }, protocols, choices);
        expect("mutation" in plan).toBe(true);
        if (!("mutation" in plan)) continue;
        expect(plan.mutation.protocol).toBe(want);
        expect(plan.mutation.variants?.[0]?.selector).toEqual({ videoSeconds: "5" });
    }
});

test("batch enable recognizes GPT image versions and relay aliases with list-only catalogs", () => {
    for (const name of ["gpt-image-2", "gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "openai/gpt-image-2.5-flare", "dall-e-3"]) {
        for (const catalog of [undefined, { id: name }, { id: name, supportedEndpointTypes: ["openai"] }, { id: name, supportedEndpointTypes: ["generate", "edit"] }]) {
            const plan = planChannelModelBatchUpdate(item(name, "image"), catalog, protocols, choices);
            expect("mutation" in plan).toBe(true);
            if ("mutation" in plan) {
                expect(plan.mutation).toMatchObject({ capability: "image", protocol: "openai-image", enabled: true, providerModelKey: name });
                expect(plan.inferredProtocol).toBe(true);
            }
        }
    }
});

test("OpenAI relay batch enable inherits standard routes for ID-only models and explicit endpoint paths", () => {
    for (const [name, capability, endpoints, want] of [
        ["vendor/deepseek-r1", "text", [], "chat-completion"],
        ["private-text-alias", "text", [], "chat-completion"],
        ["qwen-image", "image", [], "openai-image"],
        ["flux-1-pro", "image", ["generate", "edit"], "openai-image"],
        ["picture-alias", "image", ["POST /v1/images/generations"], "openai-image"],
        ["picture-edit-alias", "image", ["/v1/images/edits"], "openai-image"],
        ["talk-alias", "text", ["/v1/responses"], "openai-response"],
        ["speech-alias", "audio", ["/v1/audio/speech"], "openai-audio"],
        ["tts-1", "audio", [], "openai-audio"],
        ["movie-alias", "video", ["POST /v1/videos"], "newapi"],
    ] as const) {
        const plan = planChannelModelBatchUpdate(item(name, capability), { id: name, supportedEndpointTypes: [...endpoints] }, [...protocols, { value: "openai-response", label: "Responses", capability: "text", create: "POST /v1/responses", contentType: "application/json", media: "" }], choices, "openai");
        expect("mutation" in plan && plan.mutation.protocol).toBe(want);
    }
    for (const [name, capability, endpoints] of [
        ["private-video", "video", []], ["indextts2-v1", "audio", []],
        ["text-embedding-3-small", "text", ["openai"]], ["gpt-image-2", "image", ["private-image-api"]],
    ] as const) expect("reason" in planChannelModelBatchUpdate(item(name, capability), { id: name, supportedEndpointTypes: [...endpoints] }, protocols, choices, "openai")).toBe(true);
});

test("batch enable corrects unconfigured GPT image imports without changing saved image protocols", () => {
    const named = { ...item("display-alias", "text"), providerModelKey: "gpt-image-2.5-sunburst" };
    const corrected = planChannelModelBatchUpdate(named, undefined, protocols, choices);
    expect("mutation" in corrected && corrected.mutation).toMatchObject({ capability: "image", protocol: "openai-image", modelKey: "display-alias", providerModelKey: "gpt-image-2.5-sunburst" });
    const customProtocol = { value: "custom-image", label: "Custom", capability: "image" as const, create: "POST /generate", contentType: "application/json", media: "" };
    const saved = { ...item("gpt-image-2", "image"), protocol: "custom-image" };
    const plan = planChannelModelBatchUpdate(saved, { id: saved.modelKey }, [...protocols, customProtocol], choices);
    expect("mutation" in plan && plan.mutation.protocol).toBe("custom-image");
    const missingPlugin = planChannelModelBatchUpdate(item("gpt-image-2", "image"), undefined, protocols.filter((p) => p.value !== "openai-image"), choices);
    expect("reason" in missingPlugin).toBe(true);
});

test("batch enable corrects old H3 audio classification but does not guess a TTS route", () => {
    const h3 = planChannelModelBatchUpdate(item("minimax_h3_image_audio_to_video", "audio"), { id: "minimax_h3_image_audio_to_video", supportedEndpointTypes: ["openai-video"] }, protocols, choices);
    expect("mutation" in h3).toBe(true);
    if ("mutation" in h3) {
        expect(h3.mutation.capability).toBe("video");
        expect(h3.mutation.protocol).toBe("newapi");
        expect(h3.correctedCapability).toBe(true);
    }
    const tts = planChannelModelBatchUpdate(item("indextts2-v1", "audio"), { id: "indextts2-v1", supportedEndpointTypes: ["openai", "openai-video"] }, protocols, choices);
    expect("reason" in tts).toBe(true);
    const disable = planChannelModelBatchUpdate(item("indextts2-v1", "audio"), undefined, protocols, { ...choices, status: "disable" });
    expect("mutation" in disable).toBe(true);
    if ("mutation" in disable) {
        expect(disable.mutation.enabled).toBe(false);
        expect(disable.mutation.protocol).toBeUndefined();
    }
});
