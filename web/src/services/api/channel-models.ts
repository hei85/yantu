import { http } from "@/services/api/request";

export type ChannelModel = {
    id: string;
    channelId: string;
    modelKey: string;
    providerModelKey: string;
    displayName: string;
    channelLabel?: string;
    description?: string;
    sortOrder?: number;
    icon: string;
    capability: "text" | "image" | "video" | "audio" | "";
    protocol?: import("@/lib/model-protocols").ModelProtocol;
    enabled: boolean;
    capabilityVersion?: number;
    capabilityConfig?: import("@/lib/model-capabilities").ModelCapabilityConfig;
    variants: ChannelModelVariant[];
    createdAt: string;
    updatedAt: string;
};

/** 渠道模型的规格档只用于匹配上游模型标识，不参与任何计费。 */
export type ChannelModelVariant = {
    id: string;
    channelModelId: string;
    selector: Record<string, string>;
    selectorKey: string;
    resolution: string;
    videoSeconds: number;
    providerModelKey: string;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
};

export type ChannelModelMutation = {
    modelKey: string;
    providerModelKey?: string;
    displayName?: string;
    channelLabel?: string;
    description?: string;
    icon?: string;
    capability: ChannelModel["capability"];
    protocol?: ChannelModel["protocol"];
    enabled?: boolean;
    capabilityConfig?: ChannelModel["capabilityConfig"];
};

export function listAdminChannelModels(channelId: string) {
    return http.get<{ models: ChannelModel[] }>(`/admin/channels/${encodeURIComponent(channelId)}/models`);
}

// 管理员从上游读取模型目录；确认导入后才会写入渠道模型，启用仍需人工确认。
export function fetchAdminChannelModels(channelId: string) {
    return http.post<{ models: string[] }>(`/admin/channels/${encodeURIComponent(channelId)}/models/fetch`);
}

export function importAdminChannelModels(channelId: string, models: string[]) {
    return http.post<{ models: string[]; added: number }>(`/admin/channels/${encodeURIComponent(channelId)}/models/import`, { models });
}

export function testAdminChannelModel(channelId: string, input: Pick<ChannelModel, "modelKey" | "providerModelKey" | "capability" | "protocol"> & { capabilityConfig?: ChannelModel["capabilityConfig"] }) {
    return http.post<{ durationMs: number }>(`/admin/channels/${encodeURIComponent(channelId)}/models/test`, input, { timeout: 10 * 60 * 1000 });
}

export function createAdminChannelModel(channelId: string, input: ChannelModelMutation) {
    return http.post<{ model: ChannelModel }>(`/admin/channels/${encodeURIComponent(channelId)}/models`, input);
}

export function updateAdminChannelModel(channelId: string, id: string, input: ChannelModelMutation) {
    return http.patch<{ model: ChannelModel }>(`/admin/channels/${encodeURIComponent(channelId)}/models/${encodeURIComponent(id)}`, input);
}

export function updateAdminChannelModelSort(channelId: string, id: string, sortOrder: number) {
    return http.patch<{ updated: boolean }>(`/admin/channels/${encodeURIComponent(channelId)}/models/${encodeURIComponent(id)}/sort`, { sortOrder });
}

export function deleteAdminChannelModel(channelId: string, id: string) {
    return http.delete<{ ok: boolean }>(`/admin/channels/${encodeURIComponent(channelId)}/models/${encodeURIComponent(id)}`);
}

export function deleteAdminChannelModels(channelId: string, modelIds: string[]) {
    return http.post<{ deleted: number }>(`/admin/channels/${encodeURIComponent(channelId)}/models/batch-delete`, { modelIds });
}