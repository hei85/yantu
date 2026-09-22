import { App, Button, Form, Input, Segmented } from "antd";
import { Link2, Save, Settings2 } from "lucide-react";
import { useState } from "react";

import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import {
    createModelChannel,
    encodeChannelModel,
    normalizeConfigSnapshot,
    useConfigStore,
    type ModelCapability,
    type ModelChannel,
} from "@/stores/use-config-store";

type Props = {
    onOpenAdvanced: () => void;
};

const capabilityOptions: Array<{ label: string; value: ModelCapability }> = [
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

export function ModelQuickConnectPane({ onOpenAdvanced }: Props) {
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const replaceConfig = useConfigStore((state) => state.replaceConfig);
    const [apiUrl, setApiUrl] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [modelName, setModelName] = useState("");
    const [capability, setCapability] = useState<ModelCapability>("text");

    const save = () => {
        const normalizedUrl = normalizeQuickApiUrl(apiUrl, capability);
        const model = modelName.trim();
        if (!normalizedUrl) return message.error("请填写正确的 API 地址");
        if (!apiKey.trim()) return message.error("请填写 API Key");
        if (!model) return message.error("请填写模型名称");
        const connection = quickProtocolFor(normalizedUrl, capability);
        if (!connection) return message.error("该地址暂不支持当前模型用途，请更换地址或用途");
        if (connection.protocol === "claude-api" && capability !== "text") return message.error("Anthropic Messages 仅支持文本模型");
        if (connection.protocol === "gemini-veo" && capability !== "video") return message.error("Gemini Veo 仅支持视频模型");

        const existing = config.channels.find((channel) => channel.scope !== "system" && channel.baseUrl.trim().replace(/\/+$/u, "") === normalizedUrl);
        const channel = existing || createModelChannel({
            name: quickChannelName(normalizedUrl),
            baseUrl: normalizedUrl,
            apiKey: apiKey.trim(),
            apiFormat: connection.apiFormat,
            models: [],
            modelCosts: [],
        });
        const nextChannel: ModelChannel = {
            ...channel,
            baseUrl: normalizedUrl,
            apiKey: apiKey.trim(),
            apiFormat: connection.apiFormat,
            models: Array.from(new Set([...channel.models, model])),
            modelCosts: [
                ...(channel.modelCosts || []).filter((item) => item.model !== model),
                {
                    model,
                    displayName: model,
                    channelLabel: channel.name,
                    capability,
                    protocol: connection.protocol,
                    billingMode: "fixed_request",
                    unitPriceMicrocredits: 0,
                    ...(capability === "image" || capability === "video" ? { capabilityConfig: defaultModelCapabilityConfig(connection.protocol, model) } : {}),
                },
            ],
        };
        const channels = existing ? config.channels.map((item) => (item.id === existing.id ? nextChannel : item)) : [...config.channels, nextChannel];
        const normalized = normalizeConfigSnapshot({ config: { ...config, channels } }).config;
        const defaultKey = defaultModelKey(capability);
        const selected = encodeChannelModel(nextChannel.id, model);
        replaceConfig({
            ...normalized,
            ...(defaultKey ? { [defaultKey]: selected } : {}),
            ...(capability === "text" ? { model: selected } : {}),
        });
        message.success(existing ? "已更新快速接入配置" : "已添加快速接入配置");
        setApiUrl("");
        setApiKey("");
        setModelName("");
    };

    return (
        <div className="settings-pane">
            <div className="settings-pane-header">
                <div className="min-w-0">
                    <h2>快速接入</h2>
                    <p>只需要填写 API 地址、API Key 和模型名称。接口类型会根据地址自动识别。</p>
                </div>
            </div>
            <div className="settings-section">
                <Form layout="vertical" requiredMark={false} onFinish={save}>
                    <div className="grid gap-4 lg:grid-cols-2">
                        <Form.Item label="API 地址" required className="mb-0 lg:col-span-2">
                            <Input
                                value={apiUrl}
                                inputMode="url"
                                placeholder="例如 https://api.openai.com/v1 或 https://你的中转站地址"
                                prefix={<Link2 className="size-4 opacity-45" />}
                                onChange={(event) => setApiUrl(event.target.value)}
                            />
                        </Form.Item>
                        <Form.Item label="API Key" required className="mb-0">
                            <Input.Password value={apiKey} autoComplete="new-password" placeholder="填写服务商提供的 API Key / Token" onChange={(event) => setApiKey(event.target.value)} />
                        </Form.Item>
                        <Form.Item label="模型名称" required className="mb-0">
                            <Input value={modelName} placeholder="例如 gpt-5、gemini-2.5-pro 或 minimax_h3_z0903" onChange={(event) => setModelName(event.target.value)} />
                        </Form.Item>
                        <Form.Item label="模型用途" className="mb-0 lg:col-span-2">
                            <Segmented<ModelCapability> block options={capabilityOptions} value={capability} onChange={setCapability} />
                        </Form.Item>
                    </div>
                    <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                        <Button type="text" icon={<Settings2 className="size-4" />} onClick={onOpenAdvanced}>高级渠道配置</Button>
                        <Button type="primary" htmlType="submit" icon={<Save className="size-4" />}>保存接入配置</Button>
                    </div>
                </Form>
            </div>
        </div>
    );
}

function normalizeQuickApiUrl(value: string, capability: ModelCapability) {
    const raw = value.trim();
    if (!raw) return "";
    try {
        const url = new URL(raw);
        if (url.protocol !== "http:" && url.protocol !== "https:") return "";
        if (url.hostname.endsWith("autodl.art")) return url.origin;
        url.hash = "";
        url.search = "";
        const path = url.pathname.replace(/\/+$/u, "");
        const suffixes = [
            "/chat/completions",
            "/responses",
            "/images/generations",
            "/audio/speech",
            capability === "video" ? "/videos" : "",
            capability === "video" ? "/video/generations" : "",
        ].filter(Boolean).sort((left, right) => right.length - left.length);
        const suffix = suffixes.find((item) => path.toLowerCase().endsWith(item));
        url.pathname = (suffix ? path.slice(0, -suffix.length) : path) || "/";
        if (url.pathname === "/") return url.origin;
        return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
    } catch {
        return "";
    }
}

function quickProtocolFor(baseUrl: string, capability: ModelCapability): { protocol: string; apiFormat: "openai" | "gemini" | "claude" } | null {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    if (hostname.endsWith("autodl.art")) {
        if (capability === "video") return { protocol: "autodl-comfyui", apiFormat: "openai" };
        if (capability === "audio") return { protocol: "autodl-comfyui-audio", apiFormat: "openai" };
        return null;
    }
    if (hostname.includes("anthropic.com")) return capability === "text" ? { protocol: "claude-api", apiFormat: "claude" } : null;
    if (hostname.includes("generativelanguage.googleapis.com") || hostname.includes("googleapis.com")) {
        if (capability === "text") return { protocol: "gemini-generate-content", apiFormat: "gemini" };
        if (capability === "image") return { protocol: "gemini-image", apiFormat: "gemini" };
        if (capability === "video") return { protocol: "gemini-veo", apiFormat: "gemini" };
        return null;
    }
    if (capability === "text") return { protocol: "chat-completion", apiFormat: "openai" };
    if (capability === "image") return { protocol: "openai-image", apiFormat: "openai" };
    // 中转站（NewAPI/Axon）视频统一走 /v1/video/generations；只有 OpenAI 官方视频才用 Sora 的 multipart 协议。
    if (capability === "video") return { protocol: hostname.endsWith("openai.com") ? "newapi" : "newapi-channel-2", apiFormat: "openai" };
    return { protocol: "openai-audio", apiFormat: "openai" };
}

function quickChannelName(baseUrl: string) {
    try {
        const hostname = new URL(baseUrl).hostname.replace(/^www\./u, "");
        return hostname || "我的 API";
    } catch {
        return "我的 API";
    }
}

function defaultModelKey(capability: ModelCapability) {
    if (capability === "image") return "imageModel";
    if (capability === "video") return "videoModel";
    if (capability === "audio") return "audioModel";
    return "textModel";
}
