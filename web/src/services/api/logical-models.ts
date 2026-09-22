import { http } from "@/services/api/request";

export type InputConstraint = { min: number; max: number };
export type OptionConstraint = { values?: unknown[]; min?: number; max?: number; step?: number };
export type CapabilityImageSizePreset = {
    size: string;
    tier: "1k" | "2k" | "4k";
    ratio: string;
    width: number;
    height: number;
};
export type CapabilityImageSize = {
    parameter?: "size" | "aspect_ratio";
    allowCustom?: boolean;
    presets?: CapabilityImageSizePreset[];
};
export type CapabilitySpec = {
    version: 1;
    capability: "text" | "image" | "video" | "audio";
    operations?: string[];
    inputs?: Record<string, InputConstraint>;
    options?: Record<string, OptionConstraint>;
    imageSize?: CapabilityImageSize;
};

export type ModelRequestIntent = {
    capability: CapabilitySpec["capability"];
    operation?: string;
    inputs?: Record<string, number>;
    options?: Record<string, unknown>;
};

export type PublicLogicalModel = {
    id: string;
    code: string;
    name: string;
    icon?: string;
    description: string;
    capability: CapabilitySpec["capability"];
    sortOrder: number;
    variants: PublicLogicalModelVariant[];
    legacyModelIds: string[];
    capabilitySpec: CapabilitySpec;
    capabilityProfiles: CapabilitySpec[];
    defaultOptions: Record<string, unknown>;
    available: boolean;
};

/** 规格档只描述可执行的输入组合，不包含任何价格信息。 */
export type PublicLogicalModelVariant = {
    selector: Record<string, string>;
    resolution: string;
    videoSeconds: number;
};

export type AdminLogicalRoute = {
    id: string;
    channelModelId: string;
    channelId: string;
    channelModelKey: string;
    channelModelName: string;
    enabled: boolean;
    priority: number;
    weight: number;
    available: boolean;
    capabilitySpec: CapabilitySpec;
};

export type AdminLogicalModel = PublicLogicalModel & {
    enabled: boolean;
    activeRevisionId: string;
    revisionVersion: number;
    configurationError?: string;
    availabilityError?: string;
    routes: AdminLogicalRoute[];
};

/**
 * Keep admin model responses usable when a server is upgraded before its
 * existing process or historical response shape has caught up with the
 * current contract. Collection fields must always be arrays for the page.
 */
export function normalizeAdminLogicalModel(model: AdminLogicalModel): AdminLogicalModel {
    return {
        ...model,
        variants: Array.isArray(model.variants) ? model.variants : [],
        legacyModelIds: Array.isArray(model.legacyModelIds) ? model.legacyModelIds : [],
        capabilityProfiles: Array.isArray(model.capabilityProfiles) ? model.capabilityProfiles : [],
        defaultOptions: model.defaultOptions && typeof model.defaultOptions === "object" ? model.defaultOptions : {},
        routes: Array.isArray(model.routes) ? model.routes : [],
    };
}

export type LogicalModelMutation = {
    code: string;
    name: string;
    icon: string;
    description: string;
    capability: CapabilitySpec["capability"];
    enabled: boolean;
    sortOrder: number;
    legacyModelIds?: string[];
    capabilitySpec: CapabilitySpec;
    defaultOptions: Record<string, unknown>;
    routes: Array<{ channelModelId: string; enabled: boolean; priority: number; weight: number }>;
};

export type RouteSimulationResult = {
    productMatch: { matched: boolean; reasons?: string[] };
    candidates: Array<{ routeId: string; channelModelId: string; channelModelKey: string; channelModelName: string; priority: number; weight: number; enabled: boolean; matched: boolean; blocked: boolean; inPool: boolean; reasons?: string[] }>;
};

export type ModelCatalogSource = "system";

export type PublicChannelCatalog = {
    id: string;
    name: string;
    displayName: string;
    sortOrder?: number;
    models: PublicChannelModel[];
};

export type PublicChannelModel = {
    id: string;
    modelKey: string;
    displayName: string;
    channelLabel?: string;
    description?: string;
    sortOrder?: number;
    icon: string;
    capability: string;
    protocol?: string;
    capabilityConfig?: Record<string, any>;
    variants: PublicChannelModelVariant[];
    available: boolean;
};

export type PublicChannelModelVariant = {
    id: string;
    selector?: Record<string, string>;
    resolution: string;
    videoSeconds: number;
};

export type ModelCatalogResponse = {
    source: ModelCatalogSource;
    models?: PublicLogicalModel[];
    channels?: PublicChannelCatalog[];
};

// 创作目录直接读取系统渠道模型，不使用逻辑模型及其功能开关。
export function getModelCatalog() {
    return http.get<ModelCatalogResponse>("/model-catalog");
}

export function listAdminLogicalModels() {
    return http.get<{ models?: AdminLogicalModel[] }>("/admin/logical-models").then((result) => ({
        models: Array.isArray(result?.models) ? result.models.filter(Boolean).map(normalizeAdminLogicalModel) : [],
    }));
}

export function createAdminLogicalModel(input: LogicalModelMutation) {
    return http.post<{ model: AdminLogicalModel }>("/admin/logical-models", input);
}

export function updateAdminLogicalModel(id: string, input: LogicalModelMutation) {
    return http.patch<{ model: AdminLogicalModel }>(`/admin/logical-models/${encodeURIComponent(id)}`, input);
}

export function deleteAdminLogicalModel(id: string) {
    return http.delete<{ ok: boolean }>(`/admin/logical-models/${encodeURIComponent(id)}`);
}

export function simulateAdminLogicalModel(id: string, intent: ModelRequestIntent) {
    return http.post<RouteSimulationResult>(`/admin/logical-models/${encodeURIComponent(id)}/simulate`, intent);
}