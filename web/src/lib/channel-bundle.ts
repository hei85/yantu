// 渠道分享包：只包含连接方式与模型定义，**永远不包含 API Key / Secret Key**。
// 别人导入后需要自己填写密钥，避免把凭据随配置文件传出去。
import type { ModelCapabilityConfig } from "@/lib/model-capabilities";

export const CHANNEL_BUNDLE_FORMAT = "yingce.channel-bundle";
export const CHANNEL_BUNDLE_VERSION = 1;

export type ChannelBundleHeader = { name: string; value: string };

export type ChannelBundleModel = {
    modelKey: string;
    providerModelKey?: string;
    displayName?: string;
    description?: string;
    icon?: string;
    capability: "text" | "image" | "video" | "audio" | "";
    protocol?: string;
    billingMode?: string;
    capabilityConfig?: ModelCapabilityConfig;
};

export type ChannelBundleChannel = {
    name: string;
    baseUrl: string;
    apiFormat?: string;
    headers?: ChannelBundleHeader[];
    models: ChannelBundleModel[];
};

export type ChannelBundle = {
    format: string;
    version: number;
    exportedAt: string;
    channels: ChannelBundleChannel[];
};

export function buildChannelBundle(channels: ChannelBundleChannel[]): ChannelBundle {
    return {
        format: CHANNEL_BUNDLE_FORMAT,
        version: CHANNEL_BUNDLE_VERSION,
        exportedAt: new Date().toISOString(),
        channels: channels.map((channel) => ({
            name: channel.name,
            baseUrl: channel.baseUrl,
            apiFormat: channel.apiFormat || "openai",
            headers: sharedHeaders(channel.headers || []),
            models: channel.models.map((model) => ({ ...model })),
        })),
    };
}

export function channelBundleFileName(prefix = "衍图渠道"): string {
    const stamp = new Date().toISOString().slice(0, 10);
    return `${prefix}-${stamp}.json`;
}

// 解析时严格校验结构：分享包来自别人，不能把任意 JSON 直接塞进本地配置。
export function parseChannelBundle(text: string): ChannelBundle {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new Error("不是有效的 JSON 文件");
    }
    if (!raw || typeof raw !== "object") throw new Error("分享包格式不正确");
    const record = raw as Record<string, unknown>;
    if (record.format !== CHANNEL_BUNDLE_FORMAT) throw new Error("这不是衍图渠道分享包");
    if (!Array.isArray(record.channels) || record.channels.length === 0) throw new Error("分享包里没有渠道");
    return {
        format: CHANNEL_BUNDLE_FORMAT,
        version: Number(record.version) || CHANNEL_BUNDLE_VERSION,
        exportedAt: typeof record.exportedAt === "string" ? record.exportedAt : "",
        channels: record.channels.map(parseChannel).filter((item): item is ChannelBundleChannel => Boolean(item)),
    };
}

function parseChannel(value: unknown): ChannelBundleChannel | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const name = stringValue(record.name);
    const baseUrl = stringValue(record.baseUrl);
    if (!baseUrl) return null;
    const models = Array.isArray(record.models)
        ? record.models.map(parseModel).filter((item): item is ChannelBundleModel => Boolean(item))
        : [];
    return {
        name: name || "导入的渠道",
        baseUrl,
        apiFormat: stringValue(record.apiFormat) || "openai",
        headers: Array.isArray(record.headers)
            ? record.headers
                  .map((header) => {
                      const item = header as Record<string, unknown>;
                      const headerName = stringValue(item?.name);
                      return headerName ? { name: headerName, value: stringValue(item?.value) } : null;
                  })
                  .filter((item): item is ChannelBundleHeader => Boolean(item))
            : [],
        models,
    };
}

function parseModel(value: unknown): ChannelBundleModel | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const modelKey = stringValue(record.modelKey);
    if (!modelKey) return null;
    const capability = stringValue(record.capability).toLowerCase();
    return {
        modelKey,
        providerModelKey: stringValue(record.providerModelKey) || undefined,
        displayName: stringValue(record.displayName) || undefined,
        description: stringValue(record.description) || undefined,
        icon: stringValue(record.icon) || undefined,
        capability: (["text", "image", "video", "audio"].includes(capability) ? capability : "") as ChannelBundleModel["capability"],
        protocol: stringValue(record.protocol) || undefined,
        billingMode: stringValue(record.billingMode) || undefined,
        capabilityConfig: (record.capabilityConfig as ModelCapabilityConfig | undefined) || undefined,
    };
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

// 请求头里可能藏着凭据（Authorization、X-Api-Key 等），分享时必须剔除；
// 对方导入后自己填密钥，只保留与鉴权无关的路由头。
const SENSITIVE_HEADER_PATTERN = /(authorization|cookie|token|secret|api[-_]?key|access[-_]?key|signature|credential)/iu;

export function sharedHeaders(headers: ChannelBundleHeader[]) {
    return headers
        .map((header) => ({ name: header.name.trim(), value: header.value.trim() }))
        .filter((header) => Boolean(header.name) && !SENSITIVE_HEADER_PATTERN.test(header.name));
}
