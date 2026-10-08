import { defaultModelCapabilityConfig, migrateObservedAxonGptImageCapabilityConfig, type ModelCapabilityConfig } from "@/lib/model-capabilities";
import { catalogEndpointCapability, inferCatalogModelCapability, isHeihanAxonH3Video, knownModelCatalogDefaults, modelProtocolCapability, protocolForCatalogCapability, type ModelProtocol } from "@/lib/model-protocols";
import type { ModelChannel } from "@/stores/use-config-store";

export type ChannelModelCatalogOption = { value: string; label?: string };

export type ChannelModelCatalogItem = {
    id: string;
    displayName?: string;
    description?: string;
    observed?: ModelCapabilityConfig["observed"];
    modelType?: "text" | "image" | "video" | "audio";
    supportedEndpointTypes?: string[];
    resolutionSource?: "catalog" | "model-id" | "model-profile";
    resolutionSourceURL?: string;
    defaultParameters?: {
        aspectRatio?: string;
        durationSeconds?: string;
        resolution?: string;
        size?: string;
    };
    options?: {
        aspectRatio?: ChannelModelCatalogOption[];
        durationSeconds?: ChannelModelCatalogOption[];
        resolution?: ChannelModelCatalogOption[];
        size?: ChannelModelCatalogOption[];
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
    const supportedEndpointTypes = stringArray(record.supportedEndpointTypes ?? record.supported_endpoint_types);
    const endpointCapability = catalogEndpointCapability(supportedEndpointTypes, id);
    const modelType = stringValue(record.modelType ?? record.model_type ?? record.capability).toLowerCase()
        || (endpointCapability !== "text" ? endpointCapability : "")
        || knownModelCatalogDefaults(id)?.capability || "";
    const defaultParameters = objectValue(record.defaultParameters ?? record.default_parameters);
    const options = objectValue(record.options);
    const declaredRatios = catalogOptions(options?.aspectRatio ?? options?.aspect_ratio ?? options?.aspectRatios ?? options?.aspect_ratios ?? options?.ratio ?? options?.ratios ?? record.supportedAspectRatios ?? record.supported_aspect_ratios ?? record.aspectRatios ?? record.aspect_ratios ?? record.ratios);
    const declaredDurations = catalogOptions(options?.durationSeconds ?? options?.duration_seconds ?? options?.seconds ?? options?.duration ?? options?.durations ?? record.supportedDurations ?? record.supported_durations ?? record.durations);
    const declaredResolutions = catalogOptions(options?.resolution ?? options?.resolutions ?? options?.resolution_name ?? options?.resolutionName ?? options?.supported_resolutions ?? options?.supportedResolutions ?? record.supported_resolutions ?? record.supportedResolutions ?? record.resolutions ?? record.resolution_options ?? record.resolutionOptions);
    const yingce = objectValue(record.yingce);
    const normalizedDefaults = defaultParameters
        ? {
              ...(catalogScalar(defaultParameters.aspectRatio ?? defaultParameters.aspect_ratio ?? defaultParameters.ratio) ? { aspectRatio: catalogScalar(defaultParameters.aspectRatio ?? defaultParameters.aspect_ratio ?? defaultParameters.ratio) } : {}),
              ...(catalogScalar(defaultParameters.durationSeconds ?? defaultParameters.duration_seconds ?? defaultParameters.duration ?? defaultParameters.seconds) ? { durationSeconds: catalogScalar(defaultParameters.durationSeconds ?? defaultParameters.duration_seconds ?? defaultParameters.duration ?? defaultParameters.seconds) } : {}),
              ...(catalogScalar(defaultParameters.resolution ?? defaultParameters.resolution_name ?? defaultParameters.resolutionName) ? { resolution: catalogScalar(defaultParameters.resolution ?? defaultParameters.resolution_name ?? defaultParameters.resolutionName) } : {}),
              ...(stringValue(defaultParameters.size) ? { size: stringValue(defaultParameters.size) } : {}),
          }
        : undefined;
    const normalizedOptions = options || declaredRatios.length || declaredDurations.length || declaredResolutions.length
        ? {
              ...(declaredRatios.length ? { aspectRatio: declaredRatios } : {}),
              ...(declaredDurations.length ? { durationSeconds: declaredDurations } : {}),
              ...(declaredResolutions.length ? { resolution: declaredResolutions } : {}),
              ...(catalogOptions(options?.size).length ? { size: catalogOptions(options?.size) } : {}),
          }
        : declaredResolutions.length ? { resolution: declaredResolutions } : undefined;
    return compactCatalogItem({
        id,
        displayName: stringValue(record.displayName),
        description: stringValue(record.description),
        observed: catalogObserved(yingce?.observed),
        modelType: ["text", "image", "video", "audio"].includes(modelType) ? (modelType as ChannelModelCatalogItem["modelType"]) : undefined,
        supportedEndpointTypes,
        resolutionSource: ["catalog", "model-id", "model-profile"].includes(stringValue(record.resolutionSource)) ? record.resolutionSource as ChannelModelCatalogItem["resolutionSource"] : undefined,
        resolutionSourceURL: stringValue(record.resolutionSourceURL) || undefined,
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
        const catalogProtocolCapability = catalogEndpointCapability(item.supportedEndpointTypes, item.id);
        const modelDefaults = knownModelCatalogDefaults(item.id);
        const inferredCapability = item.modelType || modelDefaults?.capability || (catalogProtocolCapability !== "text" ? catalogProtocolCapability : undefined) || existing?.capability || inferCatalogModelCapability(item.id);
        const advertisedProtocol = catalogProtocolCapability && inferredCapability !== catalogProtocolCapability ? undefined : protocolForCatalogCapability(inferredCapability, item.supportedEndpointTypes, item.id);
        const inferredProtocol = advertisedProtocol
            || ((!item.modelType || item.modelType === "video") && isHeihanAxonH3Video(channel.baseUrl, item.id) ? "newapi" : undefined)
            || protocolForCatalogCapability(inferredCapability, item.supportedEndpointTypes, item.id, channel.apiFormat);
        if (existing) {
            const capability = existing.protocol && !inferredProtocol ? existing.capability : inferredCapability || existing.capability;
            const savedProtocol = capability === existing.capability ? existing.protocol : undefined;
            const protocol = savedProtocol || advertisedProtocol || inferredProtocol;
            const capabilityChanged = capability !== existing.capability;
            const patchCapabilityConfig = hasCatalogCapabilityConfig(item) && (capability === "image" || capability === "video");
            const capabilityConfig = patchCapabilityConfig
                ? catalogCapabilityConfig(item, protocol || channel.interfaceType, capability, capabilityChanged ? undefined : existing.capabilityConfig, false)
                : capabilityChanged
                  ? undefined
                  : existing.capabilityConfig;
            const migratedCapabilityConfig = capability === "image" && !item.options?.size?.length && !item.options?.aspectRatio?.length
                ? migrateObservedAxonGptImageCapabilityConfig(channel.baseUrl, item.id, capabilityConfig || existing.capabilityConfig)
                : capabilityConfig;
            next.push({
                ...existing,
                ...(item.displayName ? { displayName: item.displayName } : {}),
                ...(item.description ? { description: item.description } : {}),
                capability,
                ...(protocol ? { protocol } : {}),
                ...(patchCapabilityConfig || capabilityChanged || migratedCapabilityConfig !== existing.capabilityConfig ? { capabilityConfig: migratedCapabilityConfig } : {}),
            });
            continue;
        }

        const capability = inferredCapability || modelProtocolCapability(channel.interfaceType);
        const protocol = inferredProtocol || (capability === "video" && !item.supportedEndpointTypes?.length ? protocolTemplateForNewCatalogModel(capability, channel, item.id) : undefined);
        if (!protocol || !capability) continue;
        const capabilityConfig = capability === "image" || capability === "video" ? catalogCapabilityConfig(item, protocol, capability, undefined, true) : undefined;
        next.push({
            model: item.id,
            ...(item.displayName ? { displayName: item.displayName } : {}),
            ...(item.description ? { description: item.description } : {}),
            capability,
            protocol,
            ...(capabilityConfig ? { capabilityConfig } : {}),
        });
    }
    return next;
}

function protocolTemplateForNewCatalogModel(capability: ChannelModelCost["capability"] | undefined, channel: Pick<ModelChannel, "interfaceType" | "baseUrl">, model: string): ModelProtocol | undefined {
    const channelProtocol = channel.interfaceType;
    if (capability === "video" && isHeihanAxonH3Video(channel.baseUrl, model)) return "newapi";
    if (!capability) return channelProtocol;
    if (modelProtocolCapability(channelProtocol) === capability || (capability === "video" && isKnownVideoProtocol(channelProtocol))) return channelProtocol;
    return catalogProtocolTemplate(capability, channel.baseUrl);
}

function isKnownVideoProtocol(protocol: ModelProtocol | undefined) {
    return [
        "agnes-video",
        "gemini-veo",
        "minimax-video",
        "newapi",
        "newapi-channel-1",
        "newapi-channel-2",
        "novita-video",
        "volcengine-ark-agent-plan-video",
        "volcengine-ark-video",
        "volcengine-jimeng-video",
        "xai-video",
    ].includes(protocol || "");
}

// 只有模型目录明确声明 openai-video 时才覆盖已有协议；没有声明的目录
// 沿用渠道协议或按地址选择默认值。用户仍可在高级设置中调整其他模型。
function catalogProtocolTemplate(capability: ChannelModelCost["capability"], baseUrl: string): ModelProtocol | undefined {
    const hostname = catalogHostname(baseUrl);
    if (hostname.endsWith("autodl.art")) {
        if (capability === "video") return "autodl-comfyui";
        if (capability === "audio") return "autodl-comfyui-audio";
    }
    if (capability === "video") return undefined;
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
    return Boolean(item.defaultParameters || item.options || item.supportsImages !== undefined || item.minImages !== undefined || item.maxImages !== undefined || item.observed?.length);
}

function catalogCapabilityConfig(item: ChannelModelCatalogItem, protocol: ModelProtocol | undefined, capability: "image" | "video", existing: ModelCapabilityConfig | undefined, isNew: boolean): ModelCapabilityConfig {
    const fallback = defaultModelCapabilityConfig(protocol, item.id);
    const existingProfile = capability === "image" ? existing?.image : existing?.video;
    const config = structuredClone(existingProfile ? existing! : fallback);
    if (!existingProfile && existing?.observed?.length) config.observed = [...existing.observed];
    if (item.observed?.length) config.observed = mergeObservedCapabilityEvidence(config.observed || [], item.observed);
    if (capability === "image") {
        const sizeOptions = optionValues(item.options?.size);
        const ratioOptions = optionValues(item.options?.aspectRatio);
        const hasSizeOptions = Boolean(item.options?.size?.length);
        const hasRatioOptions = Boolean(item.options?.aspectRatio?.length);
        const hasOptions = hasSizeOptions || hasRatioOptions;
        const advertisedValues = hasSizeOptions ? sizeOptions : ratioOptions;
        if (hasOptions) {
            const allowsCustom = advertisedValues.includes("*");
            const concreteValues = advertisedValues.filter((value) => value !== "*");
            const image = config.image!;
            image.size = {
                ...image.size,
                parameter: hasSizeOptions ? "size" : "aspect_ratio",
                values: [...concreteValues, ...(allowsCustom ? ["*"] : [])],
                default: (hasSizeOptions ? item.defaultParameters?.size : item.defaultParameters?.aspectRatio)?.trim()
                    && concreteValues.includes((hasSizeOptions ? item.defaultParameters?.size : item.defaultParameters?.aspectRatio)!.trim())
                    ? (hasSizeOptions ? item.defaultParameters?.size : item.defaultParameters?.aspectRatio)!.trim()
                    : concreteValues[0] || image.size.default,
                allowCustom: allowsCustom,
            };
        }
        if (item.supportsImages === false) config.image!.references.maxImages = 0;
        else if (item.maxImages !== undefined) config.image!.references.maxImages = item.maxImages;
        return config;
    }

    const video = config.video!;
    const canInitialize = isNew || !existing?.video;
    if (isNew) {
        video.resolutions = [];
        video.defaultResolution = "";
    }
    const durations = uniqueNumbers(optionValues(item.options?.durationSeconds));
    const defaultDuration = positiveNumber(item.defaultParameters?.durationSeconds);
    const durationAbsent = !video.duration?.default && !video.duration?.values?.length && !video.duration?.min && !video.duration?.max;
    if (durations.length && (canInitialize || durationAbsent)) {
        video.duration = { selection: "enum", values: durations, default: durations.includes(defaultDuration) ? defaultDuration : durations[0]! };
    } else if (defaultDuration > 0 && (canInitialize || durationAbsent)) {
        video.duration = { selection: "enum", values: [defaultDuration], default: defaultDuration };
    }
    const ratios = optionValues(item.options?.aspectRatio);
    const defaultRatio = item.defaultParameters?.aspectRatio?.trim() || "";
    if (ratios.length && (canInitialize || !video.ratios?.length)) {
        video.ratios = ratios;
        video.defaultRatio = ratios.includes(defaultRatio) ? defaultRatio : ratios[0]!;
    } else if (defaultRatio && (canInitialize || !video.ratios?.length)) {
        video.ratios = [defaultRatio];
        video.defaultRatio = defaultRatio;
    }

    // The backend discovers catalogue tiers and labels model/profile matches.
    // Preserve the provenance so inferred choices are not presented as tested.
    const resolutions = optionValues(item.options?.resolution);
    const defaultResolution = item.defaultParameters?.resolution?.trim() || "";
    const explicitResolutionRejection = config.observed?.some((item) => item?.feature === "resolution" && item.verdict === "unsupported");
    const providerDeclaration = !item.resolutionSource || item.resolutionSource === "catalog";
    const replaceUnmodifiedInference = providerDeclaration && isUnmodifiedResolutionInference(video, item.id);
    if ((resolutions.length || defaultResolution) && !explicitResolutionRejection && (canInitialize || !video.resolutions?.length || replaceUnmodifiedInference)) {
        video.resolutions = resolutions.length ? resolutions : [defaultResolution];
        video.defaultResolution = video.resolutions.includes(defaultResolution) ? defaultResolution : video.resolutions[0] || "";
        video.resolutionSource = item.resolutionSource || "catalog";
        video.resolutionSourceURL = item.resolutionSourceURL;
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

function isUnmodifiedResolutionInference(video: NonNullable<ModelCapabilityConfig["video"]>, model: string) {
    if (!["model-id", "model-profile"].includes(video.resolutionSource || "")) return false;
    const key = model.trim().toLowerCase().replace(/[ _]/g, "-").split("/").pop() || "";
    const fromId = model.match(/(?:^|[-_/\s])((?:[1-4][0-9]{2,3})p|2k|4k)(?:$|[-_/\s])/i)?.[1].toUpperCase();
    const expected = video.resolutionSource === "model-id" && fromId ? [fromId]
        : ["minimax-h3", "minimax-h3-1", "h3", "h3-1"].includes(key) ? ["768P", "2K"]
        : ["minimax-h3-max", "minimax-h3-max-1", "h3-max", "h3-max-1"].includes(key) ? ["480P", "768P"] : [];
    const defaultValue = fromId && video.resolutionSource === "model-id" ? fromId : "768P";
    return expected.length > 0 && JSON.stringify(video.resolutions) === JSON.stringify(expected) && video.defaultResolution === defaultValue;
}

function compactCatalogItem(item: ChannelModelCatalogItem): ChannelModelCatalogItem {
    const defaultParameters = item.defaultParameters && Object.values(item.defaultParameters).some(Boolean) ? item.defaultParameters : undefined;
    const options = item.options && Object.values(item.options).some((values) => values?.length) ? item.options : undefined;
    return {
        id: item.id,
        ...(item.displayName ? { displayName: item.displayName } : {}),
        ...(item.description ? { description: item.description } : {}),
        ...(item.observed?.length ? { observed: item.observed } : {}),
        ...(item.modelType ? { modelType: item.modelType } : {}),
        ...(item.supportedEndpointTypes?.length ? { supportedEndpointTypes: item.supportedEndpointTypes } : {}),
        ...(defaultParameters ? { defaultParameters } : {}),
        ...(options ? { options } : {}),
        ...(item.resolutionSource ? { resolutionSource: item.resolutionSource } : {}),
        ...(item.resolutionSourceURL ? { resolutionSourceURL: item.resolutionSourceURL } : {}),
        ...(item.supportsImages !== undefined ? { supportsImages: item.supportsImages } : {}),
        ...(item.minImages !== undefined ? { minImages: item.minImages } : {}),
        ...(item.maxImages !== undefined ? { maxImages: item.maxImages } : {}),
    };
}

function catalogObserved(value: unknown): ModelCapabilityConfig["observed"] {
    if (!Array.isArray(value)) return undefined;
    return value.flatMap((raw) => {
        const record = objectValue(raw);
        const feature = stringValue(record?.feature);
        if (!record || !feature) return [];
        const details = objectValue(record.details);
        return [{
            ...record,
            feature,
            ...(stringValue(record.reason) ? { reason: stringValue(record.reason) } : {}),
            ...(stringValue(record.source) ? { source: stringValue(record.source) } : {}),
            ...(stringValue(record.verdict) ? { verdict: stringValue(record.verdict) } : {}),
            ...(stringValue(record.at) ? { at: stringValue(record.at) } : {}),
            ...(details ? { details } : {}),
        } as NonNullable<ModelCapabilityConfig["observed"]>[number]];
    });
}

function mergeObservedCapabilityEvidence(existing: NonNullable<ModelCapabilityConfig["observed"]>, incoming: NonNullable<ModelCapabilityConfig["observed"]>) {
    const merged = [...existing];
    for (const next of incoming) {
        const source = next.source || "";
        const priorIndex = merged.findIndex((item) => item.feature === next.feature && (item.source || "") === source);
        if (priorIndex >= 0) merged.splice(priorIndex, 1);
        merged.push(next);
    }
    return merged;
}

function objectValue(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function catalogScalar(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? String(value) : stringValue(value);
}

function stringArray(value: unknown) {
    return Array.isArray(value) ? Array.from(new Set(value.map(stringValue).filter(Boolean))) : [];
}

function catalogOptions(value: unknown): ChannelModelCatalogOption[] {
    const wrapper = objectValue(value);
    if (wrapper) return catalogOptions(wrapper.enum ?? wrapper.values ?? wrapper.options);
    if (!Array.isArray(value)) return catalogScalar(value) ? [{ value: catalogScalar(value) }] : [];
    const seen = new Set<string>();
    const options: ChannelModelCatalogOption[] = [];
    for (const raw of value) {
        const record = objectValue(raw);
        const scalar = record?.value ?? record?.id ?? record?.name ?? raw;
        const optionValue = typeof scalar === "number" && Number.isFinite(scalar) ? String(scalar) : stringValue(scalar);
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
