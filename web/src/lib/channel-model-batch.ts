import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import type { ChannelModelCatalogItem } from "@/lib/channel-model-catalog";
import { catalogEndpointCapability, knownModelCatalogDefaults, normalizeCatalogEndpoint, protocolForCatalogCapability, type ModelProtocolDefinition, type ProtocolCapability } from "@/lib/model-protocols";
import type { ChannelModel, ChannelModelMutation } from "@/services/api/channel-models";

export type ChannelModelBatchChoices = {
    capability: "keep" | ChannelModel["capability"];
    protocol: string;
    status: "keep" | "enable" | "disable";
};

export type ChannelModelBatchPlan =
    | { mutation: ChannelModelMutation; inferredProtocol: boolean; correctedCapability: boolean }
    | { reason: string };

export function planChannelModelBatchUpdate(
    item: ChannelModel,
    catalog: ChannelModelCatalogItem | undefined,
    protocols: ModelProtocolDefinition[],
    choices: ChannelModelBatchChoices,
    apiFormat = "openai",
): ChannelModelBatchPlan {
    const upstreamModel = item.providerModelKey || item.modelKey;
    const endpointTypes = catalog?.supportedEndpointTypes || [];
    const endpoints = new Set(endpointTypes.map(normalizeCatalogEndpoint));
    const modelDefaults = knownModelCatalogDefaults(upstreamModel);
    const endpointCapability = catalogEndpointCapability(endpointTypes, upstreamModel);
    const inferredCapability = catalog?.modelType || modelDefaults?.capability || (endpointCapability !== "text" ? endpointCapability : undefined);
    // Older imports classified "image_audio_to_video" as audio because of
    // the word "audio". Its advertised video endpoint and model ID agree.
    const correctedVideoCapability = item.capability === "audio" && endpoints.has("openai-video") && /video/i.test(upstreamModel);
    const correctedCapability = choices.capability === "keep" && (correctedVideoCapability
        || (!item.protocol && Boolean(inferredCapability) && item.capability !== inferredCapability));
    const capability = choices.capability === "keep"
        ? correctedCapability ? correctedVideoCapability ? "video" : inferredCapability! : item.capability || inferredCapability || ""
        : choices.capability;
    if (!isCapability(capability)) return { reason: "缺少模型能力" };

    const currentProtocol = protocols.find((entry) => entry.value === item.protocol && entry.capability === capability && entry.enabled !== false);
    const suggested = protocolForCatalogCapability(capability, endpointTypes, upstreamModel, apiFormat);
    const protocol = choices.protocol === "keep"
        ? currentProtocol?.value || suggested
        : choices.protocol;
    const definition = protocols.find((entry) => entry.value === protocol && entry.capability === capability && entry.enabled !== false);
    const disableWithoutProtocol = choices.status === "disable" && choices.protocol === "keep" && !definition;
    if (!definition && !disableWithoutProtocol) {
        return { reason: protocol
            ? `协议 ${protocol} 未安装或不适用于${capabilityLabel(capability)}`
            : `尚未识别该模型的${capabilityLabel(capability)}调用方式` };
    }

    const safeProtocol = definition?.value;
    const configChanged = capability !== item.capability || safeProtocol !== item.protocol;
    const capabilityConfig = configChanged
        ? capability === "audio" ? item.capabilityConfig : defaultModelCapabilityConfig(safeProtocol, upstreamModel)
        : item.capabilityConfig;
    return {
        mutation: {
            modelKey: item.modelKey,
            providerModelKey: upstreamModel,
            displayName: item.displayName,
            channelLabel: item.channelLabel,
            description: item.description,
            icon: item.icon,
            capability,
            protocol: safeProtocol,
            enabled: choices.status === "keep" ? item.enabled : choices.status === "enable",
            capabilityConfig,
            variants: (item.variants || []).map((variant) => ({
                selector: variant.selector,
                resolution: variant.resolution,
                videoSeconds: variant.videoSeconds,
                providerModelKey: variant.providerModelKey,
                enabled: variant.enabled,
            })),
        },
        inferredProtocol: choices.protocol === "keep" && Boolean(safeProtocol) && safeProtocol !== item.protocol,
        correctedCapability,
    };
}

function isCapability(value: string): value is ProtocolCapability {
    return value === "text" || value === "image" || value === "video" || value === "audio";
}

function capabilityLabel(value: ProtocolCapability) {
    return { text: "文本", image: "图片", video: "视频", audio: "音频" }[value];
}
