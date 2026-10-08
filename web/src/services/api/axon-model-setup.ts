// SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
import { AXON_BASE_URL, isAxonBaseUrl } from "@/lib/distribution-policy";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import type { ChannelBundle } from "@/lib/channel-bundle";
import { normalizeModelProtocol } from "@/lib/model-protocols";
import { createAdminChannel, deleteAdminChannel, listAdminChannels, updateAdminChannel } from "./auth";
import { importAdminChannelModels, listAdminChannelModels, updateAdminChannelModel, type ChannelModelMutation } from "./channel-models";

// Keep the existing one-model form while saving credentials and catalog-backed
// records through the same backend used by advanced channel management.
export async function connectAxonModel(apiKey: string, input: ChannelModelMutation) {
    const existing = (await listAdminChannels({ page: 1, pageSize: 200 })).channels;
    const names = new Set(existing.map((channel) => channel.name));
    let name = "Axon";
    for (let index = 2; names.has(name); index += 1) name = `Axon（${index}）`;
    const { channel } = await createAdminChannel({ name, baseUrl: AXON_BASE_URL, apiKey, enabled: false, headers: [] });
    try {
        await importAdminChannelModels(channel.id, [input.modelKey]);
        const imported = (await listAdminChannelModels(channel.id)).models.find((item) =>
            item.modelKey.toLowerCase() === input.modelKey.toLowerCase());
        if (!imported) throw new Error("所选模型没有导入，请从 Axon 目录确认准确的模型 ID");
        if (imported.capability && imported.capability !== input.capability) {
            throw new Error(`模型用途与 Axon 目录不一致，目录中的用途为 ${imported.capability}`);
        }
        const protocol = imported.protocol || input.protocol;
        if (!protocol) throw new Error("请在高级接入中配置该模型的请求协议");
        const { model } = await updateAdminChannelModel(channel.id, imported.id, {
            ...input,
            modelKey: imported.modelKey,
            providerModelKey: imported.providerModelKey,
            displayName: imported.displayName,
            description: imported.description,
            icon: imported.icon,
            protocol,
            enabled: true,
            capabilityConfig: imported.capabilityConfig || defaultModelCapabilityConfig(protocol, imported.modelKey),
        });
        await updateAdminChannel(channel.id, { name, baseUrl: AXON_BASE_URL, enabled: true });
        return { channel, model };
    } catch (error) {
        // No generation is submitted by setup, so this new connection cannot
        // have acquired task references. Do not leave failed duplicate cards.
        await deleteAdminChannel(channel.id).catch(() => undefined);
        throw error;
    }
}

export async function importAxonChannelBundle(bundle: ChannelBundle) {
    if (bundle.channels.some((channel) => !isAxonBaseUrl(channel.baseUrl))) {
        throw new Error("此发行版只能导入 Axon 中转站的模型配置");
    }
    const configured = (await listAdminChannels({ page: 1, pageSize: 200 })).channels
        .filter((channel) => isAxonBaseUrl(channel.baseUrl) && channel.hasApiKey);
    // Bundles never include credentials. Match each connection before writing
    // anything, rather than silently assigning a different account/group key.
    const targets = bundle.channels.map((source) => {
        const target = configured.find((channel) => channel.name === source.name)
            || (bundle.channels.length === 1 && configured.length === 1 ? configured[0] : undefined);
        if (!target) throw new Error(`请先为“${source.name}”保存自己的 Axon API Key，再导入模型配置`);
        return { source, target };
    });
    let count = 0;
    for (const { source, target } of targets) {
        if (!source.models.length) continue;
        await importAdminChannelModels(target.id, source.models.map((model) => model.modelKey));
        const imported = (await listAdminChannelModels(target.id)).models;
        for (const definition of source.models) {
            const item = imported.find((model) => model.modelKey.toLowerCase() === definition.modelKey.toLowerCase());
            if (!item) throw new Error(`模型 ${definition.modelKey} 未从 Axon 目录导入`);
            const protocol = normalizeModelProtocol(definition.protocol || item.protocol);
            await updateAdminChannelModel(target.id, item.id, {
                modelKey: item.modelKey,
                providerModelKey: item.providerModelKey,
                displayName: definition.displayName || item.displayName,
                description: definition.description || item.description,
                icon: definition.icon || item.icon,
                capability: definition.capability || item.capability,
                protocol,
                enabled: item.enabled,
                capabilityConfig: definition.capabilityConfig || item.capabilityConfig,
                variants: item.variants,
            });
        }
        await updateAdminChannel(target.id, { name: target.name, baseUrl: AXON_BASE_URL, headers: source.headers || target.headers || [], enabled: target.enabled !== false });
        count += 1;
    }
    return count;
}
