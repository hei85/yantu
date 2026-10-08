import { App, Button, Form, Input, Segmented } from "antd";
import { Link2, Save, Settings2 } from "lucide-react";
import { useState } from "react";

import { AXON_BASE_URL } from "@/lib/distribution-policy";
import { refreshSystemChannels } from "@/lib/user-session";
import { connectAxonModel } from "@/services/api/axon-model-setup";
import { isHeihanAxonH3Video } from "@/lib/model-protocols";
import {
    encodeChannelModel,
    useConfigStore,
    type ModelCapability,
} from "@/stores/use-config-store";

type Props = {
    onOpenAdvanced: () => void;
};
type QuickVideoProtocol = "newapi" | "newapi-channel-2";

const capabilityOptions: Array<{ label: string; value: ModelCapability }> = [
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

export function ModelQuickConnectPane({ onOpenAdvanced }: Props) {
    const { message } = App.useApp();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const [apiUrl, setApiUrl] = useState(AXON_BASE_URL);
    const [saving, setSaving] = useState(false);
    const [apiKey, setApiKey] = useState("");
    const [modelName, setModelName] = useState("");
    const [capability, setCapability] = useState<ModelCapability>("image");
    const [videoProtocolChoice, setVideoProtocolChoice] = useState<QuickVideoProtocol | "">("");
    const [lastAdded, setLastAdded] = useState<{ model: string; purpose: string; channel: string } | null>(null);

    const save = async () => {
        if (saving) return;
        const normalizedUrl = normalizeQuickApiUrl(apiUrl, capability);
        const model = modelName.trim();
        if (!normalizedUrl) return message.error("请填写正确的 API 地址");
        if (!apiKey.trim()) return message.error("请填写 API Key");
        if (!model) return message.error("请填写模型名称");
        const detectedVideoProtocol = capability === "video" ? detectVideoProtocol(apiUrl) : undefined;
        const knownVideo = capability === "video" ? knownVideoProtocol(normalizedUrl, model) : undefined;
        if (knownVideo && detectedVideoProtocol && knownVideo !== detectedVideoProtocol) {
            return message.error(`该服务地址使用 ${knownVideo === "newapi" ? "/videos（size 像素尺寸）" : "/video/generations（aspect_ratio 比例）"}；粘贴的完整接口路径与此冲突`);
        }
        const needsVideoChoice = capability === "video" && requiresVideoProtocolChoice(normalizedUrl, model);
        const videoProtocol = capability === "video"
            ? (needsVideoChoice ? detectedVideoProtocol || videoProtocolChoice || undefined : knownVideo)
            : undefined;
        if (capability === "video" && isHeihanAxonH3Video(normalizedUrl, model) && videoProtocol !== "newapi") {
            return message.error("Heihan H3 目前使用 /videos 接口；请粘贴该接口地址或选择 /videos");
        }
        if (needsVideoChoice && !videoProtocol) return message.error("请选择视频接口类型；请按服务商文档确认支持哪个接口");
        const connection = quickProtocolFor(normalizedUrl, capability, model, videoProtocol);
        if (!connection) return message.error("该地址暂不支持当前模型用途，请更换地址或用途");
        if (connection.protocol === "claude-api" && capability !== "text") return message.error("Anthropic Messages 仅支持文本模型");
        if (connection.protocol === "gemini-veo" && capability !== "video") return message.error("Gemini Veo 仅支持视频模型");

        setSaving(true);
        try {
            const saved = await connectAxonModel(apiKey.trim(), { modelKey: model, capability, protocol: connection.protocol });
            await refreshSystemChannels();
            const selected = encodeChannelModel(saved.channel.id, saved.model.modelKey);
            updateConfig(defaultModelKey(capability), selected);
            if (capability === "text") updateConfig("model", selected);
            message.success(`已添加配置，并设为${capabilityLabel(capability)}创作默认。配置已保存，能否生成请以实际使用结果为准。`);
            setLastAdded({ model: saved.model.modelKey, purpose: capabilityLabel(capability), channel: saved.channel.name });
            setApiKey("");
            setModelName("");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "添加模型失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="settings-pane">
            <div className="settings-pane-header">
                <div className="min-w-0">
                    <h2>添加模型</h2>
                    <p>填写服务商给你的 API 地址、API Key 和模型名。这里保存的是接入信息，不会自动测试或扣费；能否生成请以实际使用结果为准。</p>
                </div>
            </div>
            <div className="settings-section">
                <Form layout="vertical" requiredMark={false} onFinish={save}>
                    <div className="grid gap-4 lg:grid-cols-2">
                        <Form.Item label="模型用途" className="mb-0 lg:col-span-2">
                            <Segmented<ModelCapability> block options={capabilityOptions} value={capability} onChange={(value) => { setCapability(value); setVideoProtocolChoice(""); setLastAdded(null); }} />
                        </Form.Item>
                        <Form.Item label="API 地址" required className="mb-0 lg:col-span-2">
                            <Input
                                value={apiUrl}
                                readOnly
                                inputMode="url"
                                placeholder="例如 https://api.openai.com/v1 或 https://你的中转站地址"
                                prefix={<Link2 className="size-4 opacity-45" />}
                                onChange={(event) => { setApiUrl(event.target.value); setVideoProtocolChoice(""); setLastAdded(null); }}
                            />
                        </Form.Item>
                        {capability === "video" && requiresVideoProtocolChoice(normalizeQuickApiUrl(apiUrl, "video"), modelName) ? (
                            <Form.Item label="视频接口" className="mb-0 lg:col-span-2" extra={videoEndpointHint(apiUrl, videoProtocolChoice, modelName)}>
                                <Segmented<QuickVideoProtocol | "">
                                    block
                                    value={detectVideoProtocol(apiUrl) || knownVideoProtocol(normalizeQuickApiUrl(apiUrl, "video"), modelName) || videoProtocolChoice}
                                    options={[
                                        { label: "/videos · 像素尺寸（size）", value: "newapi" },
                                        { label: "/video/generations · 比例（aspect_ratio）", value: "newapi-channel-2" },
                                    ]}
                                    onChange={(value) => { if (!detectVideoProtocol(apiUrl) && !knownVideoProtocol(normalizeQuickApiUrl(apiUrl, "video"), modelName)) setVideoProtocolChoice(value); setLastAdded(null); }}
                                />
                            </Form.Item>
                        ) : null}
                        {capability === "video" && !requiresVideoProtocolChoice(normalizeQuickApiUrl(apiUrl, "video"), modelName) ? (
                            <p className="text-xs leading-5 text-foreground/60 lg:col-span-2">{knownVideoProtocolHint(normalizeQuickApiUrl(apiUrl, "video"), modelName)}</p>
                        ) : null}
                        <Form.Item label="API Key" required className="mb-0">
                            <Input.Password value={apiKey} autoComplete="new-password" placeholder="填写服务商提供的 API Key / Token" onChange={(event) => { setApiKey(event.target.value); setLastAdded(null); }} />
                        </Form.Item>
                        <Form.Item label="模型 ID" required className="mb-0" extra="请填写服务商模型列表里的准确 ID；别名可能导致找不到模型。">
                            <Input value={modelName} placeholder="粘贴服务商提供的完整模型 ID" onChange={(event) => { setModelName(event.target.value); setLastAdded(null); }} />
                        </Form.Item>
                    </div>
                    <p className="mt-3 rounded-md bg-surface-active px-3 py-2 text-xs leading-5 text-foreground/60">图片和视频若使用不同分组的 API Key，请分别添加为两个模型接入。每次保存只会把当前用途设为默认。</p>
                    <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                        <Button type="text" icon={<Settings2 className="size-4" />} onClick={onOpenAdvanced}>高级接入</Button>
                        <Button type="primary" htmlType="submit" loading={saving} icon={<Save className="size-4" />}>保存并设为默认</Button>
                    </div>
                </Form>
                {lastAdded ? (
                    <div className="model-setup-saved" role="status">
                        <div>
                            <strong>{lastAdded.purpose}模型 {lastAdded.model} 已保存</strong>
                            <p>接入：{lastAdded.channel}。已设为{lastAdded.purpose}创作默认；尚未验证实际生成。</p>
                        </div>
                        <Button type="link" onClick={onOpenAdvanced}>查看已接入</Button>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function capabilityLabel(capability: ModelCapability) {
    return { image: "图片", video: "视频", text: "文本", audio: "音频" }[capability];
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

function quickProtocolFor(baseUrl: string, capability: ModelCapability, model: string, videoProtocol?: QuickVideoProtocol): { protocol: string; apiFormat: "openai" | "gemini" | "claude" } | null {
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
    if (capability === "video") return videoProtocol ? { protocol: videoProtocol, apiFormat: "openai" } : null;
    return { protocol: "openai-audio", apiFormat: "openai" };
}

export function detectVideoProtocol(value: string): QuickVideoProtocol | undefined {
    try {
        const pathname = new URL(value.trim()).pathname.replace(/\/+$/u, "").toLowerCase();
        if (/\/video\/generations$/u.test(pathname)) return "newapi-channel-2";
        if (/\/videos$/u.test(pathname)) return "newapi";
    } catch {
        // Incomplete URL: let the user finish typing.
    }
    return undefined;
}

function knownVideoProtocol(baseUrl: string, model: string): QuickVideoProtocol | undefined {
    try {
        const hostname = new URL(baseUrl).hostname.toLowerCase();
        return hostname === "openai.com" || hostname.endsWith(".openai.com") || isHeihanAxonH3Video(baseUrl, model) ? "newapi" : undefined;
    } catch {
        return undefined;
    }
}

function requiresVideoProtocolChoice(baseUrl: string, model: string) {
    try {
        const hostname = new URL(baseUrl).hostname.toLowerCase();
        if (hostname.endsWith("autodl.art") || hostname.includes("generativelanguage.googleapis.com") || hostname.includes("googleapis.com")) return false;
        if (knownVideoProtocol(baseUrl, model)) return false;
        return true;
    } catch {
        return true;
    }
}

function knownVideoProtocolHint(baseUrl: string, model: string) {
    try {
        const hostname = new URL(baseUrl).hostname.toLowerCase();
        if (hostname.endsWith("autodl.art")) return "已按 AutoDL 原生视频接口接入。";
        if (hostname.includes("generativelanguage.googleapis.com") || hostname.includes("googleapis.com")) return "已按 Gemini Veo 视频接口接入。";
    } catch {
        return "";
    }
    return knownVideoProtocol(baseUrl, model) === "newapi" ? "已按已知服务地址使用 /videos（size 像素尺寸）。" : "";
}

function videoEndpointHint(apiUrl: string, selected: QuickVideoProtocol | "", model: string) {
    const detected = detectVideoProtocol(apiUrl);
    const known = knownVideoProtocol(normalizeQuickApiUrl(apiUrl, "video"), model);
    if (detected) return detected === "newapi" ? "已从完整地址识别：/videos，画幅通过 size 像素尺寸传递。" : "已从完整地址识别：/video/generations，画幅通过 aspect_ratio 比例传递。";
    if (known) return "已按已知服务地址选择 /videos（size 像素尺寸）。";
    if (!selected) return "普通中转地址无法判断接口。请查看服务商文档后选择；两种接口的画幅参数不同。";
    return selected === "newapi" ? "将请求 /videos，并以 size 发送像素尺寸。" : "将请求 /video/generations，并以 aspect_ratio 发送比例。";
}

function defaultModelKey(capability: ModelCapability) {
    if (capability === "image") return "imageModel";
    if (capability === "video") return "videoModel";
    if (capability === "audio") return "audioModel";
    return "textModel";
}
