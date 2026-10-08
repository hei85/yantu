import { createAdminChannel, listAdminChannels, updateAdminChannel } from "@/services/api/auth";
import { createAdminChannelModel, listAdminChannelModels, updateAdminChannelModel, type ChannelModelMutation } from "@/services/api/channel-models";
import { refreshSystemChannels } from "@/lib/user-session";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { encodeChannelModel, type AiConfig, type ModelChannel } from "@/stores/use-config-store";

const markerPrefix = "[portable-local:";

export type PortableChannelSyncSummary = {
    synced: Array<{ sourceChannelId: string; channelId: string; modelCount: number; created: boolean }>;
    skipped: Array<{ channelId: string; reason: string }>;
    diagnostics: string[];
};

export type PortableChannelSyncPlan = {
    channels: Array<{ source: ModelChannel; markerName: string; models: ChannelModelMutation[] }>;
    skipped: PortableChannelSyncSummary["skipped"];
};

function markerFor(channelId: string) {
    return `${markerPrefix}${encodeURIComponent(channelId)}]`;
}

function textProtocolFor(channel: ModelChannel) {
    return channel.apiFormat === "gemini" ? "gemini-generate-content"
        : channel.apiFormat === "claude" ? "claude-api"
            : "chat-completion";
}

/** Pure mapping keeps eligibility and source identity easy to validate without making network requests. */
export function buildPortableLocalChannelSyncPlan(config: AiConfig): PortableChannelSyncPlan {
    const channels: PortableChannelSyncPlan["channels"] = [];
    const skipped: PortableChannelSyncPlan["skipped"] = [];
    for (const source of config.channels || []) {
        if (source.scope === "system") continue;
        const channelId = String(source.id || "");
        const marker = markerFor(channelId);
        if (!channelId || marker.length >= 80) {
            skipped.push({ channelId, reason: "渠道标识无效或过长" });
            continue;
        }
        if (source.enabled === false) {
            skipped.push({ channelId, reason: "渠道未启用" });
            continue;
        }
        if (!source.apiKey?.trim()) {
            skipped.push({ channelId, reason: "缺少 API Key" });
            continue;
        }
        const models = (source.modelCosts || [])
            .filter((model) => (source.models || []).includes(model.model))
            .map((model): ChannelModelMutation => ({
                modelKey: model.model,
                providerModelKey: model.model,
                displayName: model.displayName || model.model,
                channelLabel: model.channelLabel || source.name,
                description: model.description || "",
                icon: model.icon || "",
                capability: model.capability,
                protocol: model.protocol || (model.capability === "text" ? textProtocolFor(source) : undefined),
                enabled: source.enabled !== false,
                capabilityConfig: model.capabilityConfig || (model.capability === "text" ? defaultModelCapabilityConfig(textProtocolFor(source), model.model) : undefined),
            }));
        // Older local-channel entries may contain a selected text model without a
        // modelCosts record. The user's textModels selection is explicit evidence
        // of its purpose; use the channel's OpenAI/Gemini/Claude text protocol.
        for (const modelKey of source.models || []) {
            if (models.some((model) => model.modelKey === modelKey)) continue;
            if (!config.textModels.includes(encodeChannelModel(source.id, modelKey))) continue;
            const protocol = textProtocolFor(source);
            models.push({
                modelKey,
                providerModelKey: modelKey,
                displayName: modelKey,
                capability: "text",
                protocol,
                enabled: true,
                capabilityConfig: defaultModelCapabilityConfig(protocol, modelKey),
            });
        }
        if (!models.length) {
            skipped.push({ channelId, reason: "没有具备能力配置的模型" });
            continue;
        }
        channels.push({ source, markerName: `${String(source.name || "本地渠道").slice(0, 79 - marker.length)} ${marker}`, models });
    }
    return { channels, skipped };
}

async function allAdminChannels() {
    const channels: ModelChannel[] = [];
    for (let page = 1; ; page += 1) {
        const result = await listAdminChannels({ page, pageSize: 100 });
        channels.push(...result.channels);
        if (channels.length >= result.total || result.channels.length === 0) return channels;
    }
}

/** Copies configured local channels into the backend system catalog; this never tests or calls upstream models. */
export async function syncPortableLocalChannels(config: AiConfig): Promise<PortableChannelSyncSummary> {
    const plan = buildPortableLocalChannelSyncPlan(config);
    const summary: PortableChannelSyncSummary = { synced: [], skipped: plan.skipped, diagnostics: [] };
    const existing = await allAdminChannels();
    for (const item of plan.channels) {
        const marker = markerFor(item.source.id);
        const owned = existing.find((channel) => channel.scope === "system" && channel.name.endsWith(marker));
        const input = {
            name: item.markerName,
            baseUrl: item.source.baseUrl,
            apiKey: item.source.apiKey,
            secretKey: item.source.secretKey,
            headers: item.source.headers || [],
            apiFormat: item.source.apiFormat,
            interfaceType: item.source.interfaceType,
            enabled: item.source.enabled !== false,
            models: item.models.map((model) => model.modelKey),
            scope: "system" as const,
        };
        const result = owned
            ? await updateAdminChannel(owned.id, input)
            : await createAdminChannel(input);
        const target = result.channel;
        const currentModels = await listAdminChannelModels(target.id);
        for (const model of item.models) {
            // Model keys are scoped to an owned channel, so matching here cannot claim another system provider's model.
            const current = currentModels.models.find((candidate) => candidate.modelKey === model.modelKey);
            if (current) await updateAdminChannelModel(target.id, current.id, model);
            else await createAdminChannelModel(target.id, model);
        }
        summary.synced.push({ sourceChannelId: item.source.id, channelId: target.id, modelCount: item.models.length, created: !owned });
    }
    await refreshSystemChannels();
    summary.diagnostics.push("仅同步配置与模型目录；未调用上游模型或触发付费请求。");
    return summary;
}
