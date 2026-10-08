import type { ModelChannel } from "@/stores/use-config-store";
import type { CanvasDrawingEngineSetting } from "@/lib/canvas/canvas-drawing-engine";
import type { FeatureAvailability } from "@/stores/use-user-store";
import { http, apiBaseURL } from "@/services/api/request";
import type { PublicLogicalModel } from "@/services/api/logical-models";


let authSessionRequest: Promise<AuthSessionPayload> | null = null;
let authSessionCache: { payload: AuthSessionPayload; expiresAt: number } | null = null;

export type LocalUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
    role: "admin" | "user";
    status: "active" | "disabled";
    lastLoginAt?: string;
    createdAt: string;
    updatedAt: string;
};

export type AdminUser = LocalUser;

export type AuthSessionPayload = {
    user: LocalUser | null;
    logicalModels?: PublicLogicalModel[];
    runtimeLimits?: RuntimeLimits;
    drawingEngine?: CanvasDrawingEngineSetting;
    features?: FeatureAvailability;
};

export type RuntimeLimits = {
    activeTaskLimit: number;
    resourceUploadMB: number;
    recycleBinRetentionDays?: number;
};

export type AdminAuditEvent = {
    id: string;
    actorUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    summary: string;
    metadataJson?: string;
    createdAt: string;
};

export type AdminUserDetail = {
    user: LocalUser;
    counts: { tasks: number; apiCalls: number; auditEvents: number };
    storageUsage: {
        assetCount: number;
        assetBytes: number;
        taskCount: number;
        taskBytes: number;
        apiCallCount: number;
    };
    storedFileBytes: number;
    dailyUploadBytes: number;
    quota: RuntimeResourcePolicy;
};

export type AdminUserTask = {
    id: string;
    type: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    stage: string;
    progress: number;
    model?: string;
    providerRequestId?: string;
    createdAt: string;
};

export type AdminReferenceData = {
    users: Array<{ id: string; username: string; displayName: string }>;
    channels: Array<{ id: string; name: string; enabled: boolean; models: string[] }>;
};

export type PromptTemplate = {
    id: string;
    operation: string;
    name: string;
    version: number;
    content: string;
    outputType: "json" | "text";
    enabled: boolean;
    createdBy?: string;
    createdAt: string;
    updatedAt: string;
};

export type PromptTemplateVariable = {
    label: string;
    placeholder: string;
};

export type PromptOperationDefinition = {
    operation: string;
    label: string;
    category: string;
    description: string;
    outputType: "json" | "text";
    schemaKey?: string;
    variables: PromptTemplateVariable[];
    outputContract: string;
};

export type UserPromptCustomization = {
    id: string;
    operation: string;
    mode: "inherit" | "append" | "rewrite";
    content: string;
    baseTemplateId: string;
    updatedAt: string;
};

export type UserPromptPreference = {
    definition: PromptOperationDefinition;
    template: PromptTemplate | null;
    customization?: UserPromptCustomization;
    outdated: boolean;
};

export type RuntimeResourcePolicy = {
    resourceUploadMB: number;
    generatedFileMB: number;
    dailyUploadMB: number;
    storedFileGB: number;
    structuredDataMB: number;
    taskDataGB: number;
    assetCount: number;
    taskCount: number;
    apiCallLogCount: number;
    recycleBinRetentionDays?: number;
};

export function getAuthSession() {
    const now = Date.now();
    if (authSessionCache && authSessionCache.expiresAt > now) return Promise.resolve(authSessionCache.payload);
    if (authSessionRequest) return authSessionRequest;
    authSessionRequest = http.get<AuthSessionPayload>("/auth/session")
        .then((payload) => {
            authSessionCache = { payload, expiresAt: Date.now() + 5_000 };
            return payload;
        })
        .finally(() => {
            authSessionRequest = null;
        });
    return authSessionRequest;
}

export function getSystemChannels() {
    return http.get<{ channels: ModelChannel[] }>("/channels/system");
}

export function getFeatureAvailability() {
    return http.get<{ features: FeatureAvailability }>("/features");
}

export type AdminListParams = { keyword?: string; status?: string; role?: string; page?: number; pageSize?: number };

export function listAdminUsers(params: AdminListParams = {}) {
    return http.get<{ users: AdminUser[]; total: number; page: number; pageSize: number }>("/admin/users", { params });
}

export function createAdminUser(input: { username: string; displayName: string; password: string; role: LocalUser["role"]; status: LocalUser["status"] }) {
    return http.post<{ user: AdminUser }>("/admin/users", input);
}

export function getAdminReferences() {
    return http.get<AdminReferenceData>("/admin/references");
}

export function getAdminUserDetail(id: string) {
    return http.get<AdminUserDetail>(`/admin/users/${encodeURIComponent(id)}/detail`);
}

export function listAdminUserTasks(id: string, params: { page?: number; pageSize?: number } = {}) {
    return http.get<{ tasks: AdminUserTask[]; total: number; page: number; pageSize: number }>(`/admin/users/${encodeURIComponent(id)}/tasks`, { params });
}

export function listAdminUserAuditEvents(id: string, params: { page?: number; pageSize?: number } = {}) {
    return http.get<{ events: AdminAuditEvent[]; total: number; page: number; pageSize: number }>(`/admin/users/${encodeURIComponent(id)}/audit-events`, { params });
}

export function updateAdminUser(id: string, input: Partial<Pick<LocalUser, "displayName" | "role" | "status">> & { password?: string }) {
    return http.patch<{ user: LocalUser }>(`/admin/users/${encodeURIComponent(id)}`, input);
}

export function deleteAdminUser(id: string) {
    return http.delete<{ ok: boolean }>(`/admin/users/${encodeURIComponent(id)}`);
}

export function bulkDisableAdminUsers(userIds: string[]) {
    return http.post<{ users: LocalUser[]; disabledCount: number }>("/admin/users/bulk-disable", { userIds });
}

export function listAdminChannels(params: AdminListParams = {}) {
    return http.get<{ channels: ModelChannel[]; total: number; page: number; pageSize: number }>("/admin/channels", { params });
}

export function createAdminChannel(input: Partial<ModelChannel> & { useGlobalConcurrency?: boolean }) {
    return http.post<{ channel: ModelChannel }>("/admin/channels", input);
}

export function duplicateAdminChannel(id: string) {
    return http.post<{ channel: ModelChannel }>(`/admin/channels/${encodeURIComponent(id)}/duplicate`);
}

export function updateAdminChannel(id: string, input: Partial<ModelChannel> & { useGlobalConcurrency?: boolean }) {
    return http.patch<{ channel: ModelChannel }>(`/admin/channels/${encodeURIComponent(id)}`, input);
}

export function deleteAdminChannel(id: string) {
    return http.delete<{ ok: boolean }>(`/admin/channels/${encodeURIComponent(id)}`);
}

export function listAdminPromptTemplates() {
    return http.get<{ templates: PromptTemplate[]; definitions: PromptOperationDefinition[] }>("/admin/prompt-templates");
}

export function createAdminPromptTemplate(input: Pick<PromptTemplate, "operation" | "name" | "content"> & { enabled?: boolean }) {
    return http.post<{ template: PromptTemplate }>("/admin/prompt-templates", input);
}

export function updateAdminPromptTemplate(id: string, input: Pick<PromptTemplate, "operation" | "name" | "content"> & { enabled?: boolean }) {
    return http.patch<{ template: PromptTemplate }>(`/admin/prompt-templates/${encodeURIComponent(id)}`, input);
}

export function deleteAdminPromptTemplate(id: string) {
    return http.delete<{ ok: boolean }>(`/admin/prompt-templates/${encodeURIComponent(id)}`);
}

export function listUserPromptPreferences() {
    return http.get<{ preferences: UserPromptPreference[] }>("/settings/prompt-templates");
}

export function updateUserPromptCustomization(operation: string, input: Pick<UserPromptCustomization, "mode" | "content">) {
    return http.patch<{ customization: UserPromptCustomization }>(`/settings/prompt-templates/${encodeURIComponent(operation)}`, input);
}

export function resetUserPromptCustomization(operation: string) {
    return http.delete<{ ok: boolean }>(`/settings/prompt-templates/${encodeURIComponent(operation)}`);
}

export function getAdminDrawingEngineSetting() {
    return http.get<{ setting: CanvasDrawingEngineSetting }>("/admin/settings/drawing-engine");
}

export function updateAdminDrawingEngineSetting(input: Pick<CanvasDrawingEngineSetting, "defaultEngine" | "tldrawLicenseKey">) {
    return http.patch<{ setting: CanvasDrawingEngineSetting }>("/admin/settings/drawing-engine", input);
}

