export const CONTENT_MODERATION_ERROR_CODE = "sensitive_words_detected";

export const CONTENT_MODERATION_MESSAGE = "模型服务的内容审核拒绝了请求。若提示词正常，可能是误判，请联系渠道处理。";

const DEFAULT_GENERATION_ERROR_MESSAGE = "生成失败，请稍后重试。";
const NETWORK_ERROR_MESSAGE = "网络异常。";

export type GenerationFailureMetadata = {
    errorDetails: string;
    generationErrorCode?: string;
    failedPromptFingerprint?: string;
};

export function generationFailureMetadata(error: unknown, prompt: string): GenerationFailureMetadata {
    const raw = rawGenerationError(error);
    if (!isContentModerationError(raw)) return { errorDetails: generationErrorMessage(error) };
    return {
        errorDetails: CONTENT_MODERATION_MESSAGE,
        generationErrorCode: CONTENT_MODERATION_ERROR_CODE,
        failedPromptFingerprint: generationPromptFingerprint(prompt),
    };
}

export function generationErrorMessage(error: unknown) {
    const errorCode = taskErrorCode(error);
    const raw = rawGenerationError(error);
    if (errorCode === "model_access_denied") return "当前渠道的 API Key 无权使用所选模型。请在中转站开通该模型，或切换有权限的模型。";
    if (errorCode === "model_not_found" || errorCode === "model_missing" || /\bmodel_not_found\b/i.test(raw)) return "当前中转站分组中的模型不可用，请检查模型名称或分组配置。";
    if (errorCode === CONTENT_MODERATION_ERROR_CODE || isContentModerationError(raw)) return CONTENT_MODERATION_MESSAGE;
    if (/^模型服务拒绝了请求，请检查模型和参数[。.]?$/.test(raw)) return "模型服务拒绝了请求；可能是内容审核、渠道路由或参数限制，请查看问题诊断。";
    if (/Axon H3 参考图需要公网 URL/i.test(raw)) return "参考图尚未成功传到生成上游，视频任务未提交。请检查素材上传连接。";
    if (/Axon H3 参考音频需要公网 URL/i.test(raw)) return "参考音频尚未成功传到生成上游，视频任务未提交。请检查素材上传连接。";

    const providerMessage = extractStructuredProviderMessage(raw) || extractWrappedProviderMessage(raw);
    const displayMessage = providerMessage || raw;
    if (isContentModerationError(displayMessage)) return CONTENT_MODERATION_MESSAGE;
    const resourceStorageMessage = resourceStorageFailureMessage(raw) || resourceStorageFailureMessage(displayMessage);
    if (resourceStorageMessage) return resourceStorageMessage;
    if (hasHttpStatus(raw, 503)) return "中转站返回 HTTP 503，请检查模型/分组或稍后重试。";
    if (isNetworkFailure(displayMessage)) return NETWORK_ERROR_MESSAGE;
    if (!providerMessage) {
        if (hasHttpStatus(raw, 429)) return "服务当前繁忙，请稍后重试。";
        if (hasHttpStatus(raw, 401, 403)) return "生成服务鉴权失败，请检查渠道配置。";
        if (hasHttpStatus(raw, 404)) return "生成服务地址不可用，请检查渠道配置。";
        if (hasHttpStatus(raw, 500, 502, 504) || containsInfrastructureDetails(raw)) return NETWORK_ERROR_MESSAGE;
    }
    return displayMessage || DEFAULT_GENERATION_ERROR_MESSAGE;
}

export function generationErrorCode(error: unknown) {
    if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
        const code = (error as { code: string }).code;
        if (/^(?:model|provider|origin)_[a-z0-9_]{2,80}$/.test(code)) return code;
    }
    return undefined;
}

export function isContentModerationError(value: unknown) {
    const text = value instanceof Error ? value.message : String(value || "");
    return text.toLowerCase().includes(CONTENT_MODERATION_ERROR_CODE) || text.includes("内容审核未通过") || text.includes("内容审核拒绝");
}

export function unchangedModeratedPrompt(metadata: { errorDetails?: string; generationErrorCode?: string; failedPromptFingerprint?: string } | undefined, prompt: string) {
    const moderationFailure = metadata?.generationErrorCode === CONTENT_MODERATION_ERROR_CODE || isContentModerationError(metadata?.errorDetails);
    if (!moderationFailure) return false;
    if (!metadata?.failedPromptFingerprint) return true;
    return metadata.failedPromptFingerprint === generationPromptFingerprint(prompt);
}

// 指纹只用于识别“原样重试”，不是安全或鉴权用途。
export function generationPromptFingerprint(value: string) {
    const normalized = value.trim().replace(/\s+/g, " ");
    let hash = 2166136261;
    for (let index = 0; index < normalized.length; index += 1) {
        hash ^= normalized.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${normalized.length}:${(hash >>> 0).toString(36)}`;
}

function rawGenerationError(error: unknown) {
    if (error instanceof Error) return error.message.trim();
    if (typeof error === "string") return error.trim();
    if (error && typeof error === "object") {
        const record = error as Record<string, unknown>;
        if (typeof record.error === "string") return record.error.trim();
        if (typeof record.message === "string") return record.message.trim();
        // Task records can carry upstream detail; only consume known-safe codes and status here.
        if (typeof record.statusCode === "number") return String(record.statusCode);
        if (record.status === "cancelled" && !record.error) return "任务已取消";
    }
    return providerPayloadMessage(error);
}

function taskErrorCode(error: unknown) {
    if (!error || typeof error !== "object") return "";
    const value = (error as Record<string, unknown>).errorCode;
    return typeof value === "string" ? value.toLowerCase() : "";
}

function extractStructuredProviderMessage(raw: string) {
    for (let index = raw.indexOf("{"); index >= 0; index = raw.indexOf("{", index + 1)) {
        try {
            const message = providerPayloadMessage(JSON.parse(raw.slice(index).trim()));
            if (message) return message;
        } catch {
            // 上游常把 JSON 拼在 HTTP 状态后；不是完整 JSON 时继续尝试下一个对象起点。
        }
    }
    return "";
}

function extractWrappedProviderMessage(raw: string) {
    const interfaceFailure = raw.match(/^接口请求失败[:：]\s*(.*)$/s);
    const requestFailure = raw.match(/^Request failed with status code \d{3}\s*[:：-]?\s*(.+)$/is);
    const wrapped = interfaceFailure?.[1] ?? requestFailure?.[1];
    if (!wrapped) return "";
    const message = wrapped.replace(/^\d{3}(?:\s+(?:Bad Gateway|Service Unavailable|Gateway Timeout|Internal Server Error|Not Found|Unauthorized|Forbidden|Too Many Requests))?\s*[:：-]?\s*/i, "").trim();
    return message && !containsInfrastructureDetails(message) ? message : "";
}

function providerPayloadMessage(payload: unknown): string {
    if (typeof payload === "string") return payload.trim();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
    const record = payload as Record<string, unknown>;
    if (record.error && typeof record.error === "object") {
        const nested = providerPayloadMessage(record.error);
        if (nested) return nested;
    }
    for (const key of ["message", "msg", "detail"] as const) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return typeof record.error === "string" ? record.error.trim() : "";
}

function isNetworkFailure(value: string) {
    return /\b(?:dial tcp|connection refused|connection reset|no such host|i\/o timeout|context deadline exceeded|network error|failed to fetch|fetch failed|socket hang up|econnrefused|econnreset|etimedout)\b/i.test(value);
}

function hasHttpStatus(value: string, ...statuses: number[]) {
    return statuses.some((status) => new RegExp(`\\b${status}\\b`).test(value));
}

function containsInfrastructureDetails(value: string) {
    return /(?:接口请求失败|Request failed with status code|https?:\/\/|\b(?:GET|POST|PUT|PATCH|DELETE)\s+["']?|Bad Gateway|Service Unavailable|Gateway Timeout|upstream_error)/i.test(value);
}

function resourceStorageFailureMessage(value: string) {
    if (!value) return "";
    if (/\bUserDisable\b/i.test(value)) return "对象存储账号已停用，请检查或更换对象存储配置。";
    if (/(?:参考(?:图片|媒体)上传失败|OSS 上传失败|对象存储|腾讯云 COS|七牛云)/i.test(value)) {
        return "参考素材上传到对象存储失败，请检查对象存储配置后重试。";
    }
    return "";
}
