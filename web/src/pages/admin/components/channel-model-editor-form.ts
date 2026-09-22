import type { ModelCapabilityChoice } from "@/components/model-protocol-picker";
import { defaultModelCapabilityConfig, normalizeModelCapabilityConfig, type ModelCapabilityConfig } from "@/lib/model-capabilities";
import type { ModelProtocolDefinition } from "@/lib/model-protocols";
import type { ChannelModel } from "@/services/api/channel-models";

export type ChannelModelFormValues = {
    modelKey: string;
    providerModelKey?: string;
    displayName?: string;
    channelLabel?: string;
    description?: string;
    icon?: string;
    capability: ModelCapabilityChoice;
    protocol?: string;
    enabled: boolean;
    capabilityConfig?: ModelCapabilityConfig;
};

export type EditorSection = "identity" | "capabilities";

export function editorSectionForField(name: (string | number)[]): EditorSection {
    return name[0] === "capabilityConfig" ? "capabilities" : "identity";
}

export function initialChannelModelValues(item: ChannelModel | null, protocols: ModelProtocolDefinition[]): ChannelModelFormValues {
    const capability = item?.capability || "text";
    const protocol = item ? item.protocol : protocols.find((p) => p.capability === capability && p.enabled !== false)?.value;
    const upstreamModel = item?.providerModelKey || item?.modelKey || "";
    return {
        modelKey: item?.modelKey || "",
        providerModelKey: upstreamModel,
        displayName: item?.displayName || "",
        channelLabel: item?.channelLabel || "",
        description: item?.description || "",
        icon: item?.icon || "",
        capability,
        protocol,
        enabled: item?.enabled ?? true,
        capabilityConfig: capability === "audio" ? undefined : normalizeModelCapabilityConfig(item?.capabilityConfig || defaultModelCapabilityConfig(protocol, upstreamModel)),
    };
}

// Clear incompatible selectors without inventing protocol-specific values.
export function changeChannelModelCapability(values: ChannelModelFormValues, protocols: ModelProtocolDefinition[]): ChannelModelFormValues {
    const capability = values.capability;
    const protocol = protocols.find((p) => p.value === values.protocol && p.capability === capability && p.enabled !== false)?.value || protocols.find((p) => p.capability === capability && p.enabled !== false)?.value;
    return {
        ...values,
        protocol,
        capabilityConfig: capability === "audio" ? undefined : defaultModelCapabilityConfig(protocol, values.providerModelKey?.trim() || values.modelKey.trim()),
    };
}

export function validateChannelModelProtocol(capability: string, protocol: string | undefined, protocols: ModelProtocolDefinition[]) {
    if (!protocols.some((p) => p.value === protocol && p.capability === capability && p.enabled !== false)) {
        throw new Error("请选择当前能力下已启用的请求协议");
    }
}

