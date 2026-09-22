import { groupModelsByDisplayName, type DisplayModelGroup } from "@/lib/model-selection";
import { modelIcon, modelOptionName, PUBLIC_MODEL_CATALOG_ID, resolveModelChannel, type AiConfig } from "@/stores/use-config-store";

export type ModelPickerGroup = {
    key: string;
    label: string;
    icon: string;
    scope: string;
    kind: "product" | "channel";
    models: DisplayModelGroup[];
};

export function isDirectSystemModel(config: AiConfig, value: string) {
    if (!value) return false;
    const channel = resolveModelChannel(config, value);
    const cost = channel.modelCosts?.find((item) => item.model === modelOptionName(value));
    return channel.scope === "system" && channel.id !== PUBLIC_MODEL_CATALOG_ID && !cost?.logicalModelId;
}

export function modelChannelLabel(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    const cost = channel.modelCosts?.find((item) => item.model === modelOptionName(value));
    return cost?.channelLabel?.trim() || channel.name || "未命名渠道";
}

// 一级按渠道展开，二级列出该渠道下可选的模型。
// 系统渠道也按渠道聚合（而不是按模型名跨渠道聚合），这样“一个渠道里有哪些模型”一眼可见；
// 模型的取值、能力、协议与请求路径完全不变，只是列表分组方式不同。
export function groupModelsForPicker(config: AiConfig, options: string[]): ModelPickerGroup[] {
    const groups: ModelPickerGroup[] = [];
    const seen = new Set<string>();
    for (const channel of config.channels) {
        const models = options.filter((value) => resolveModelChannel(config, value).id === channel.id);
        if (!models.length) continue;
        const key = JSON.stringify(["channel", channel.id]);
        if (seen.has(key)) continue;
        seen.add(key);
        const isPublicCatalog = channel.id === PUBLIC_MODEL_CATALOG_ID;
        const isSystemChannel = channel.scope === "system" && !isPublicCatalog;
        groups.push({
            key,
            label: channel.name || "未命名渠道",
            icon: modelIcon(config, models[0]),
            scope: isPublicCatalog ? "" : isSystemChannel ? "平台服务" : "我的模型",
            kind: "channel",
            models: groupModelsByDisplayName(config, models),
        });
    }
    return groups;
}
