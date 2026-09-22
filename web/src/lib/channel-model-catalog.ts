import { defaultModelCapabilityConfig, type ModelCapabilityConfig } from "@/lib/model-capabilities";
import { modelProtocolCapability, protocolForModelCatalog, type ModelProtocol } from "@/lib/model-protocols";
import type { ModelChannel } from "@/stores/use-config-store";

export type ChannelModelCatalogOption = { value: string; label?: string };

export type ChannelModelCatalogItem = {
    id: string;
    displayName?: string;
    modelType?: "text" | "image" | "video" | "audio";
    supportedEndpointTypes?: string[];
    defaultParameters?: {
        aspectRatio?: string;
        durationSeconds?: string;
        resolution?: string;
    };
    options?: {
        aspectRatio?: ChannelModelCatalogOption[];
        durationSeconds?: ChannelModelCatalogOption[];
        resolution?: ChannelModelCatalogOption[];
    };
    supportsImages?: boolean;
    minImages?: number;
    maxImages?: number;
};

type ChannelModelCost = NonNullable<ModelChannel["modelCosts"]>[number];

export function sanitizeChannelModelCatalogItem(value: unknown): ChannelModelCatalogItem | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const id = stringValue(record.id);
    if (!id) return null;
    const modelType = stringValue(record.modelType).toLowerCase();
    const defaultParameters = objectValue(record.defaultParameters);
    const options = objectValue(record.options);
    const normalizedDefaults = defaultParameters
        ? {
              ...(stringValue(defaultParameters.aspectRatio) ? { aspectRatio: stringValue(defaultParameters.aspectRatio) } : {}),
              ...(stringValue(defaultParameters.durationSeconds) ? { durationSeconds: stringValue(defaultParameters.durationSeconds) } : {}),
              ...(stringValue(defaultParameters.resolution) ? { resolution: stringValue(defaultParameters.resolution) } : {}),
          }
        : undefined;
    const normalizedOptions = options
        ? {
              ...(catalogOptions(options.aspectRatio).length ? { aspectRatio: catalogOptions(options.aspectRatio) } : {}),
              ...(catalogOptions(options.durationSeconds).length ? { durationSeconds: catalogOptions(options.durationSeconds) } : {}),
              ...(catalogOptions(options.resolution).length ? { resolution: catalogOptions(options.resolution) } : {}),
          }
        : undefined;
    return compactCatalogItem({
        id,
        displayName: stringValue(record.displayName),
        modelType: ["text", "image", "video", "audio"].includes(modelType) ? (modelType as ChannelModelCatalogItem["modelType"]) : undefined,
        supportedEndpointTypes: stringArray(record.supportedEndpointTypes),
        defaultParameters: normalizedDefaults,
        options: normalizedOptions,
        supportsImages: typeof record.supportsImages === "boolean" ? record.supportsImages : undefined,
        minImages: nonNegativeInteger(record.minImages),
        maxImages: nonNegativeInteger(record.maxImages),
    });
}

export function mergeFetchedChannelModelCosts(channel: ModelChannel, catalog: ChannelModelCatalogItem[]): ChannelModelCost[] {
    const existingByModel = new Map((channel.modelCosts || []).map((cost) => [cost.model, cost]));
    const next: ChannelModelCost[] = [];
    for (const item of catalog) {
        const existing = existingByModel.get(item.id);
        const inferredProtocol = protocolForModelCatalog(item.supportedEndpointTypes);
        const inferredCapability = modelProtocolCapability(inferredProtocol) || item.modelType;
        if (existing) {
            const protocol = inferredProtocol || existing.protocol;
            const capability = inferredCapability || existing.capability;
            const capabilityChanged = capability !== existing.capability;
            const patchCapabilityConfig = hasCatalogCapabilityConfig(item) && (capability === "image" || capability === "video");
            const capabilityConfig = patchCapabilityConfig
                ? catalogCapabilityConfig(item, protocol || channel.interfaceType, capability, capabilityChanged ? undefined : existing.capabilityConfig, false)
                : capabilityChanged
                  ? undefined
                  : existing.capabilityConfig;
            next.push({
                ...existing,
                ...(item.displayName ? { displayName: item.displayName } : {}),
                capability,
                ...(inferredProtocol ? { protocol: inferredProtocol } : {}),
                ...(patchCapabilityConfig || capabilityChanged ? { capabilityConfig } : {}),
            });
            continue;
        }

        const capability = inferredCapability || modelProtocolCapability(channel.interfaceType);
		const protocol = inferredProtocol || protocolTemplateForNewCatalogModel(capability, channel);
        if (!protocol || !capability) continue;
        const capabilityConfig = capability === "image" || capability === "video" ? catalogCapabilityConfig(item, protocol, capability, undefined, true) : undefined;
        next.push({
            model: item.id,
            ...(item.displayName ? { displayName: item.displayName } : {}),
            capability,
            protocol,
            billingMode: "fixed_request",
            unitPriceMicrocredits: 0,
            ...(capabilityConfig ? { capabilityConfig } : {}),
        });
    }
    return next;
}

function protocolTemplateForNewCatalogModel(capability: ChannelModelCost["capability"] | undefined, channel: Pick<ModelChannel, "interfaceType" | "baseUrl">): ModelProtocol | undefined {
    const channelProtocol = channel.interfaceType;
    if (!capability) return channelProtocol;
    if (modelProtocolCapability(channelProtocol) === capability) return channelProtocol;
    return catalogProtocolTemplate(capability, channel.baseUrl);
}

// 上游模型目录只给模型名，不给请求协议，所以按渠道地址兑底一个可用默认值：
// AutoDL 走 ComfyUI 工作流协议；OpenAI 官方视频走 Sora multipart；其余（含 NewAPI 系中转站）
// 的视频走 /v1/video/generations，即 newapi-channel-2，与模型编辑器里的默认值保持一致。
function catalogProtocolTemplate(capability: ChannelModelCost["capability"], baseUrl: string): ModelProtocol {
    const hostname = catalogHostname(baseUrl);
    if (hostname.endsWith("autodl.art")) {
        if (capability === "video") return "autodl-comfyui";
        if (capability === "audio") return "autodl-comfyui-audio";
    }
    if (capability === "video") return hostname.endsWith("openai.com") ? "newapi" : "newapi-channel-2";
    if (capability === "image") return "openai-image";
    if (capability === "audio") return "openai-audio";
    return "chat-completion";
}

function catalogHostname(baseUrl: string) {
    try {
        return new URL(baseUrl).hostname.toLowerCase();
    } catch {
        return "";
    }
}

function hasCatalogCapabilityConfig(item: ChannelModelCatalogItem) {
    return Boolean(item.defaultParameters || item.options || item.supportsImages !== undefined || item.minImages !== undefined || item.maxImages !== undefined);
}

function catalogCapabilityConfig(item: ChannelModelCatalogItem, protocol: ModelProtocol | undefined, capability: "image" | "video", existing: ModelCapabilityConfig | undefined, isNew: boolean): ModelCapabilityConfig {
    const fallback = defaultModelCapabilityConfig(protocol, item.id);
    const existingProfile = capability === "image" ? existing?.image : existing?.video;
    const config = structuredClone(existingProfile ? existing! : fallback);
    if (capability === "image") {
        if (item.supportsImages === false) config.image!.references.maxImages = 0;
        else if (item.maxImages !== undefined) config.image!.references.maxImages = item.maxImages;
        return config;
    }

    const video = config.video!;
    if (isNew) {
        video.resolutions = [];
        video.defaultResolution = "";
    }
    const durations = uniqueNumbers(optionValues(item.options?.durationSeconds));
    const defaultDuration = positiveNumber(item.defaultParameters?.durationSeconds);
    if (durations.length) {
        video.duration = { selection: "enum", values: durations, default: durations.includes(defaultDuration) ? defaultDuration : durations[0]! };
    } else if (defaultDuration > 0) {
        video.duration = { selection: "enum", values: [defaultDuration], default: defaultDuration };
    }
    const ratios = optionValues(item.options?.aspectRatio);
    const defaultRatio = item.defaultParameters?.aspectRatio?.trim() || "";
    if (ratios.length) {
        video.ratios = ratios;
        video.defaultRatio = ratios.includes(defaultRatio) ? defaultRatio : ratios[0]!;
    } else if (defaultRatio) {
        video.ratios = [defaultRatio];
        video.defaultRatio = defaultRatio;
    }

    // A catalog-backed video may only emit resolution_name when the provider
    // explicitly advertises compatible values. An empty list means omit it.
    const resolutions = optionValues(item.options?.resolution);
    const defaultResolution = item.defaultParameters?.resolution?.trim() || "";
    if (resolutions.length || defaultResolution) {
        video.resolutions = resolutions.length ? resolutions : [defaultResolution];
        video.defaultResolution = video.resolutions.includes(defaultResolution) ? defaultResolution : video.resolutions[0] || "";
    }

    if (item.supportsImages === false || item.maxImages === 0) {
        video.references.minImages = 0;
        video.references.maxImages = 0;
        video.operations = video.operations.filter((operation) => operation !== "image_to_video");
        if (!video.operations.length) video.operations = ["text_to_video"];
        video.defaultOperation = video.operations.includes(video.defaultOperation) ? video.defaultOperation : video.operations[0]!;
    } else {
        if (item.maxImages !== undefined) video.references.maxImages = item.maxImages;
        if (item.minImages !== undefined) video.references.minImages = item.minImages;
        if (video.references.minImages > 0) {
            video.references.maxImages = Math.max(video.references.minImages, video.references.maxImages);
            video.operations = video.operations.filter((operation) => operation !== "text_to_video");
            if (!video.operations.includes("image_to_video")) video.operations.unshift("image_to_video");
            video.defaultOperation = "image_to_video";
        }
    }
    return config;
}

function compactCatalogItem(item: ChannelModelCatalogItem): ChannelModelCatalogItem {
    const defaultParameters = item.defaultParameters && Object.values(item.defaultParameters).some(Boolean) ? item.defaultParameters : undefined;
    const options = item.options && Object.values(item.options).some((values) => values?.length) ? item.options : undefined;
    return {
        id: item.id,
        ...(item.displayName ? { displayName: item.displayName } : {}),
        ...(item.modelType ? { modelType: item.modelType } : {}),
        ...(item.supportedEndpointTypes?.length ? { supportedEndpointTypes: item.supportedEndpointTypes } : {}),
        ...(defaultParameters ? { defaultParameters } : {}),
        ...(options ? { options } : {}),
        ...(item.supportsImages !== undefined ? { supportsImages: item.supportsImages } : {}),
        ...(item.minImages !== undefined ? { minImages: item.minImages } : {}),
        ...(item.maxImages !== undefined ? { maxImages: item.maxImages } : {}),
    };
}

function objectValue(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown) {
    return Array.isArray(value) ? Array.from(new Set(value.map(stringValue).filter(Boolean))) : [];
}

function catalogOptions(value: unknown): ChannelModelCatalogOption[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const options: ChannelModelCatalogOption[] = [];
    for (const raw of value) {
        const record = objectValue(raw);
        const optionValue = stringValue(record?.value);
        if (!optionValue || seen.has(optionValue)) continue;
        seen.add(optionValue);
        const label = stringValue(record?.label);
        options.push({ value: optionValue, ...(label ? { label } : {}) });
    }
    return options;
}

function optionValues(options: ChannelModelCatalogOption[] | undefined) {
    return Array.from(new Set((options || []).map((option) => option.value.trim()).filter(Boolean)));
}

function positiveNumber(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function uniqueNumbers(values: string[]) {
    return Array.from(new Set(values.map(positiveNumber).filter((value) => value > 0)));
}

function nonNegativeInteger(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}
