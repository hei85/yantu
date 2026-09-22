import { App, Button, Form, Input, Popconfirm, Segmented, Select, Tooltip } from "antd";
import { Download, Layers3, Pencil, Plus, RefreshCw, Trash2, Upload, Workflow } from "lucide-react";
import { saveAs } from "file-saver";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { refreshSystemChannels } from "@/lib/user-session";

import { ModelEditorModal } from "@/components/model-editor-modal";
import { ChannelHeadersEditor, validateChannelHeaders } from "@/components/channel-headers-editor";
import { WorkspaceState } from "@/components/layout/workspace-state";
import { mergeFetchedChannelModelCosts } from "@/lib/channel-model-catalog";
import { buildChannelBundle, channelBundleFileName, parseChannelBundle, type ChannelBundleChannel, type ChannelBundleModel } from "@/lib/channel-bundle";
import { listAdminChannelModels } from "@/services/api/channel-models";
import { fetchChannelModels } from "@/services/api/image";
import { deleteAdminChannel, listAdminChannels } from "@/services/api/auth";
import { ChannelModelManager } from "@/pages/admin/components/channel-model-manager";
import {
    createModelChannel,
    defaultBaseUrlForApiFormat,
    filterModelsByCapability,
    modelOptionsFromChannels,
    useConfigStore,
    type AiConfig,
    type ModelChannel,
    type ModelCapability,
} from "@/stores/use-config-store";
import { SystemChannelEditorModal } from "./system-channel-editor-modal";

type UserChannelConnection = "openai" | "gemini";
// 导入时只有明确声明了能力的模型才写入能力配置，其余交给模型名启发式判断。
type ChannelBundleModelWithCapability = ChannelBundleModel & { capability: ModelCapability };
type ChannelSettingsPaneProps = {
    onOpenModels: () => void;
    onOpenRunningHub?: () => void;
};

export function ChannelSettingsPane({ onOpenModels, onOpenRunningHub }: ChannelSettingsPaneProps) {
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const replaceConfig = useConfigStore((state) => state.replaceConfig);
    const [loadingChannelIds, setLoadingChannelIds] = useState<string[]>([]);
    const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
    const [newChannelId, setNewChannelId] = useState<string | null>(null);
    // 平台渠道（服务端）的连接编辑与模型管理都收敛到这一个页面。
    const [systemEditor, setSystemEditor] = useState<{ open: boolean; channel: ModelChannel | null }>({ open: false, channel: null });
    const [managingSystemChannel, setManagingSystemChannel] = useState<ModelChannel | null>(null);
    const [autoFetchSystemModels, setAutoFetchSystemModels] = useState(false);
    const [exporting, setExporting] = useState(false);
    // 平台渠道的真实状态（含已停用、是否配置密钥）只存在服务端：
    // 创作端目录只下发"已启用且有可用模型"的渠道，所以停用后渠道会从列表里消失。
    // 这里额外拉一份管理端目录，把停用的渠道也列出来，避免用户看不到、也开不回来。
    const [serverChannels, setServerChannels] = useState<ModelChannel[]>([]);
    const refreshServerChannels = useCallback(async () => {
        try {
            const result = await listAdminChannels({ page: 1, pageSize: 200 });
            setServerChannels(result.channels);
        } catch {
            /* 非管理员或接口不可用时静默跳过，不影响渠道列表展示。 */
        }
    }, []);
    const importInputRef = useRef<HTMLInputElement | null>(null);
    const userChannels = config.channels.filter((channel) => channel.scope !== "system");
    // 系统渠道由管理后台维护，不能在用户设置里编辑；这里只列出来，避免用户以为渠道丢了。
    const systemChannels = config.channels.filter((channel) => channel.scope === "system");
    const runningHubReady = Boolean(config.runningHub.enabled && config.runningHub.baseUrl.trim() && config.runningHub.apiKey.trim() && config.runningHub.workflowId.trim());

    useEffect(() => {
        void refreshServerChannels();
    }, [refreshServerChannels]);

    // 服务端存在、但没被创作端目录下发的渠道。原因有两种，必须分开说：
    //   1. 渠道自己被停用；
    //   2. 渠道是启用状态，但下面的模型全部未启用 / 没配能力与协议，因此没有可发布的模型。
    // （两者都写成“已停用”会让已经开启渠道的用户以为设置没保存。）
    const unpublishedSystemChannels = serverChannels.filter((channel) => !systemChannels.some((item) => item.id === channel.id));

    const updateChannels = (channels: ModelChannel[], baseConfig = config) => {
        replaceConfig(withChannels(baseConfig, channels));
    };

    const updateChannel = (id: string, patch: Partial<ModelChannel>) => {
        updateChannels(config.channels.map((channel) => {
            if (channel.id !== id) return channel;
            const models = patch.models ? uniqueModels(patch.models) : channel.models;
            return {
                ...channel,
                ...patch,
                models,
                modelCosts: patch.modelCosts !== undefined ? patch.modelCosts : (patch.models ? channel.modelCosts?.filter((item) => models.includes(item.model)) : channel.modelCosts),
            };
        }));
    };

    const updateChannelConnection = (channel: ModelChannel, connection: UserChannelConnection) => {
        const apiFormat = connection;
        const defaultBaseUrl = defaultBaseUrlForApiFormat(apiFormat);
        const baseUrl = isKnownDefaultBaseUrl(channel.baseUrl) ? defaultBaseUrl : channel.baseUrl;
        // 渠道只负责连接类型；具体模型能力和请求协议由下方共享能力卡片维护。
        updateChannel(channel.id, { apiFormat, interfaceType: undefined, baseUrl });
    };

    const addChannel = () => {
        const channel = createModelChannel({ name: `渠道 ${userChannels.length + 1}` });
        updateChannels([...config.channels, channel]);
        setNewChannelId(channel.id);
        setEditingChannelId(channel.id);
    };

    const closeChannelEditor = () => {
        setEditingChannelId(null);
        setNewChannelId(null);
    };

    const deleteChannel = (id: string) => {
        const channel = config.channels.find((item) => item.id === id);
        if (channel?.scope === "system") {
            message.warning("系统渠道由管理员维护");
            return;
        }
        updateChannels(config.channels.filter((item) => item.id !== id));
    };

    // 平台渠道存在服务端，删除后需要重新拉目录才能从列表里消失。
    // 导出只带连接方式与模型定义，永远不带密钥：平台渠道的密钥在服务端（前端拿不到），
    // 自有渠道的密钥在这里显式剔除。
    const exportChannels = async () => {
        setExporting(true);
        try {
            const admin = await listAdminChannels({ page: 1, pageSize: 200 });
            const systemBundles: ChannelBundleChannel[] = await Promise.all(
                admin.channels.map(async (channel) => {
                    const models = (await listAdminChannelModels(channel.id)).models;
                    return {
                        name: channel.name,
                        baseUrl: channel.baseUrl,
                        apiFormat: channel.apiFormat,
                        headers: channel.headers || [],
                        models: models.map((model) => ({
                            modelKey: model.modelKey,
                            providerModelKey: model.providerModelKey,
                            displayName: model.displayName,
                            description: model.description,
                            icon: model.icon,
                            capability: model.capability,
                            protocol: model.protocol,
                            capabilityConfig: model.capabilityConfig,
                        })),
                    };
                }),
            );
            const userBundles: ChannelBundleChannel[] = userChannels.map((channel) => ({
                name: channel.name,
                baseUrl: channel.baseUrl,
                apiFormat: channel.apiFormat,
                headers: channel.headers || [],
                models: (channel.modelCosts || []).map((cost) => ({
                    modelKey: cost.model,
                    displayName: cost.displayName,
                    description: cost.description,
                    icon: cost.icon,
                    capability: cost.capability,
                    protocol: cost.protocol,
                    capabilityConfig: cost.capabilityConfig,
                })),
            }));
            const bundle = buildChannelBundle([...systemBundles, ...userBundles]);
            saveAs(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }), channelBundleFileName());
            message.success(`已导出 ${bundle.channels.length} 个渠道（不含 API Key）`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导出渠道失败");
        } finally {
            setExporting(false);
        }
    };

    // 导入的渠道落地为本地渠道（存本机、不需要服务端权限），密钥留空由使用者自己填。
    const importChannels = async (file: File) => {
        try {
            const bundle = parseChannelBundle(await file.text());
            const created = bundle.channels.map((item) =>
                createModelChannel({
                    name: item.name,
                    baseUrl: item.baseUrl,
                    apiFormat: item.apiFormat === "gemini" ? "gemini" : "openai",
                    apiKey: "",
                    headers: item.headers,
                    models: item.models.map((model) => model.modelKey),
                    modelCosts: item.models
                        .filter((model): model is ChannelBundleModelWithCapability => Boolean(model.capability))
                        .map((model) => ({
                            model: model.modelKey,
                            displayName: model.displayName || model.modelKey,
                            channelLabel: item.name,
                            description: model.description || "",
                            icon: model.icon || "",
                            capability: model.capability,
                            protocol: model.protocol,
                            capabilityConfig: model.capabilityConfig,
                        })),
                }),
            );
            updateChannels([...config.channels, ...created]);
            message.success(`已导入 ${created.length} 个渠道，请分别填写 API Key 后启用`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导入渠道失败");
        }
    };

    // 配置里的系统渠道 baseUrl 是站内代理路径（/api/<id>），不是真实上游地址；
    // 编辑前必须回服务端取一次真实连接信息。
    const openSystemChannelEditor = async (channel: ModelChannel | null) => {
        if (!channel) {
            setSystemEditor({ open: true, channel: null });
            return;
        }
        try {
            const result = await listAdminChannels({ page: 1, pageSize: 200 });
            const fresh = result.channels.find((item) => item.id === channel.id);
            setSystemEditor({ open: true, channel: fresh || channel });
        } catch {
            setSystemEditor({ open: true, channel });
        }
    };

    const removeSystemChannel = async (channel: ModelChannel) => {
        try {
            await deleteAdminChannel(channel.id);
            await refreshServerChannels();
            await refreshSystemChannels();
            message.success("模型接入已删除");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除模型接入失败");
        }
    };

    const setChannelLoading = (id: string, loading: boolean) => {
        setLoadingChannelIds((items) => (loading ? Array.from(new Set([...items, id])) : items.filter((item) => item !== id)));
    };

    const refreshChannelModels = async (channel: ModelChannel) => {
        const connectionError = channelConnectionError(channel);
        if (connectionError) {
            message.error(`${channel.name || "当前渠道"}：${connectionError}`);
            return;
        }
        setChannelLoading(channel.id, true);
        try {
            const result = await fetchChannelModels(channel, true);
            if (!result.models.length) {
                message.warning(`${channel.name || "当前渠道"}未返回模型，已保留现有手工模型`);
                return;
            }
            const latestConfig = useConfigStore.getState().config;
            const latestChannel = latestConfig.channels.find((item) => item.id === channel.id);
            if (!latestChannel) return;
            if (channelConnectionSignature(latestChannel) !== channelConnectionSignature(channel)) {
                message.warning(`${latestChannel.name || "当前渠道"}的连接配置已改变，已忽略旧的拉取结果`);
                return;
            }
            updateChannels(
                latestConfig.channels.map((item) => (item.id === channel.id ? { ...item, models: result.models, modelCosts: mergeFetchedChannelModelCosts(item, result.catalog) } : item)),
                latestConfig,
            );
            message.success(`${latestChannel.name || "当前渠道"}模型列表已更新`);
        } catch (error) {
            message.error(channelModelFetchErrorMessage(error));
        } finally {
            setChannelLoading(channel.id, false);
        }
    };

    const refreshAllModels = async () => {
        const runnable = userChannels.filter((channel) => !channelConnectionError(channel));
        const skipped = userChannels.filter((channel) => channelConnectionError(channel));
        if (!runnable.length) {
            const detail = skipped.map((channel) => `${channel.name || "未命名渠道"}：${channelConnectionError(channel)}`).join("；");
            message.error(detail || "没有可拉取的个人模型渠道，请先填写有效 Base URL 和 API Key");
            return;
        }
        setChannelLoading("all", true);
        try {
            const results = await Promise.all(
                runnable.map(async (channel) => {
                    try {
                        const result = await fetchChannelModels(channel, true);
                        return { channel, result, error: "" };
                    } catch (error) {
                        return { channel, result: { models: [], catalog: [] }, error: error instanceof Error ? error.message : "读取失败" };
                    }
                }),
            );
            const latestConfig = useConfigStore.getState().config;
            const successful = results.filter((item) => {
                const latestChannel = latestConfig.channels.find((channel) => channel.id === item.channel.id);
                return Boolean(item.result.models.length && latestChannel && channelConnectionSignature(latestChannel) === channelConnectionSignature(item.channel));
            });
            const stale = results.filter((item) => {
                const latestChannel = latestConfig.channels.find((channel) => channel.id === item.channel.id);
                return Boolean(item.result.models.length && (!latestChannel || channelConnectionSignature(latestChannel) !== channelConnectionSignature(item.channel)));
            });
            const failed = results.filter((item) => !item.result.models.length);
            if (successful.length) {
                const resultMap = new Map(successful.map((item) => [item.channel.id, item.result] as const));
                updateChannels(
                    latestConfig.channels.map((channel) => {
                        const fetched = resultMap.get(channel.id);
                        return fetched ? { ...channel, models: fetched.models, modelCosts: mergeFetchedChannelModelCosts(channel, fetched.catalog) } : channel;
                    }),
                    latestConfig,
                );
                message.success(`已更新 ${successful.length} 个渠道的模型`);
            }
            const warnings = [
                ...failed.map((item) => `${item.channel.name || "未命名渠道"}：${item.error || "未返回模型"}`),
                ...stale.map((item) => `${item.channel.name || "未命名渠道"}：连接配置已改变，已忽略旧结果`),
                ...skipped.map((channel) => `${channel.name || "未命名渠道"}：${channelConnectionError(channel)}`),
            ];
            if (warnings.length) message.warning(`${warnings.join("；")}。未更新的渠道已保留原有模型列表`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "批量读取模型失败，原有模型列表未改动");
        } finally {
            setChannelLoading("all", false);
        }
    };

    return (
        <>
        <Form layout="vertical" requiredMark={false}>
            <div className="settings-pane-header">
                <div className="min-w-0">
                    <h2>模型接入</h2>
                    <p>把你自己的模型 API 接进来：填 Base URL 和 API Key、拉取或手选要用的模型，启用后就能在创作端直接选用。模型能力在「模型管理」里按模型配置。<Button type="link" size="small" className="h-auto p-0 text-xs font-semibold" onClick={onOpenModels}>打开模型选择</Button></p>
                </div>
                <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:shrink-0">
                    <input
                        ref={importInputRef}
                        type="file"
                        accept="application/json,.json"
                        hidden
                        style={{ display: "none" }}
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file) void importChannels(file);
                        }}
                    />
                    <Button className="h-10 flex-1 sm:h-8 sm:flex-none" icon={<Upload className="size-4" />} onClick={() => importInputRef.current?.click()}>导入</Button>
                    <Button className="h-10 flex-1 sm:h-8 sm:flex-none" icon={<Download className="size-4" />} loading={exporting} onClick={() => void exportChannels()}>导出</Button>
                    <Button className="h-10 flex-1 sm:h-8 sm:flex-none" icon={<RefreshCw className="size-4" />} loading={loadingChannelIds.includes("all")} disabled={loadingChannelIds.some((id) => id !== "all")} onClick={() => void refreshAllModels()}>拉取全部</Button>
                    <Button className="h-10 flex-1 sm:h-8 sm:flex-none" type="primary" icon={<Plus className="size-4" />} onClick={() => setSystemEditor({ open: true, channel: null })}>新增接入</Button>
                </div>
            </div>
            {onOpenRunningHub ? <section className="settings-section mb-3">
                <div className="mb-3">
                    <h3 className="text-sm font-semibold">个人工作流渠道</h3>
                    <p className="mt-1 text-xs text-foreground/55">RunningHub 使用独立的云端工作流参数与执行通道。</p>
                </div>
                <div className="grid gap-2 lg:grid-cols-2">
                    {onOpenRunningHub ? (
                        <WorkflowChannelEntry
                            icon={<Workflow className="size-4" />}
                            title="RunningHub"
                            description="云端工作流和 RunningHub App"
                            status={runningHubReady ? `${config.runningHub.workflows.length} 个工作流已配置` : config.runningHub.enabled ? "待完成连接和工作流配置" : "未启用"}
                            ready={runningHubReady}
                            onOpen={onOpenRunningHub}
                        />
                    ) : null}
                </div>
            </section> : null}
        {systemChannels.length || unpublishedSystemChannels.length || userChannels.length ? (
                    <div className="settings-channel-list space-y-2">
                        {systemChannels.map((channel) => (
                            <section key={channel.id} className="settings-channel p-2.5 sm:p-3">
                                <div className="flex flex-wrap items-start justify-between gap-2.5">
                                    <div className="min-w-0 flex-1 basis-52">
                                        <h3 className="truncate text-sm font-semibold">{channel.name || "未命名渠道"}</h3>
                                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground/55">
                                            我的模型 · {channel.models.length} 个模型 · {channel.enabled === false ? "已停用" : "已启用"}
                                            {serverChannels.find((item) => item.id === channel.id)?.hasApiKey === false ? <span className="settings-channel-status is-warning"><i aria-hidden="true" />待填写 API Key</span> : null}
                                    </div>
                                </div>
                                <div className="flex w-full justify-end gap-2 sm:w-auto sm:shrink-0">
                                    <Button className="h-10 sm:h-8" size="small" icon={<Layers3 className="size-3.5" />} onClick={() => { setAutoFetchSystemModels(false); setManagingSystemChannel(channel); }}>模型管理</Button>
                                    <Button className="h-10 sm:h-8" size="small" icon={<Pencil className="size-3.5" />} onClick={() => void openSystemChannelEditor(channel)}>编辑</Button>
                                    <Popconfirm title="删除这个模型接入？" description="删除后它和它的模型都不再显示，所有创作都不能再选用它。" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void removeSystemChannel(channel)}>
                                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} title="删除这个模型接入" aria-label="删除这个模型接入" />
                                    </Popconfirm>
                                </div>
                            </div>
                        </section>
                        ))}
                        {/* 没进创作端目录的模型接入也留在列表里，否则用户关掉后就再也找不回来。 */}
                        {unpublishedSystemChannels.map((channel) => (
                            <section key={channel.id} className={`settings-channel p-2.5 sm:p-3 ${channel.enabled === false ? "is-offline" : ""}`}>
                                <div className="flex flex-wrap items-start justify-between gap-2.5">
                                    <div className="min-w-0 flex-1 basis-52">
                                        <h3 className="truncate text-sm font-semibold">{channel.name || "未命名渠道"}</h3>
                                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground/55">
                                            {channel.enabled === false
                                                ? "我的模型 · 已停用，创作端看不到它"
                                                : "我的模型 · 已启用，但还没有可用的模型（模型未配置或未启用）"}
                                            {channel.hasApiKey === false ? <span className="settings-channel-status is-warning"><i aria-hidden="true" />待填写 API Key</span> : null}
                                        </div>
                                    </div>
                                    <div className="flex w-full justify-end gap-2 sm:w-auto sm:shrink-0">
                                        {channel.enabled === false ? null : (
                                            <Button className="h-10 sm:h-8" size="small" icon={<Layers3 className="size-3.5" />} onClick={() => { setAutoFetchSystemModels(false); setManagingSystemChannel(channel); }}>模型管理</Button>
                                        )}
                                        <Button className="h-10 sm:h-8" size="small" icon={<Pencil className="size-3.5" />} onClick={() => void openSystemChannelEditor(channel)}>{channel.enabled === false ? "编辑并启用" : "编辑"}</Button>
                                        <Popconfirm title="删除平台渠道？" description="删除后渠道与模型不再显示，所有创作都不能再选用它。" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void removeSystemChannel(channel)}>
                                            <Button size="small" danger icon={<Trash2 className="size-3.5" />} title="删除平台渠道" aria-label="删除平台渠道" />
                                        </Popconfirm>
                                    </div>
                                </div>
                            </section>
                        ))}
                    {userChannels.map((channel) => {
                        const editing = editingChannelId === channel.id;
                        return (
                            <section key={channel.id} aria-labelledby={`channel-${channel.id}-title`} className="settings-channel p-2.5 sm:p-3">
                                <div className="mb-2.5 flex flex-wrap items-start justify-between gap-2.5">
                                    <div className="min-w-0 flex-1 basis-52">
                                        <h3 id={`channel-${channel.id}-title`} className="truncate text-sm font-semibold">{channel.name || "未命名渠道"}</h3>
                                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground/55">
                                            {channelProtocolLabel(channel)} · 已保存 {channel.models.length} 个模型
                                            <ChannelStatus channel={channel} />
                                        </div>
                                    </div>
                                    <div className="flex w-full justify-end gap-2 sm:w-auto sm:shrink-0">
                                        <Button className="h-10 sm:h-8" size="small" icon={<RefreshCw className="size-3.5" />} loading={loadingChannelIds.includes(channel.id)} disabled={loadingChannelIds.includes("all")} onClick={() => void refreshChannelModels(channel)}>拉取模型</Button>
                                        <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => { setNewChannelId(null); setEditingChannelId(channel.id); }}>编辑</Button>
                                        <Popconfirm title="删除个人模型渠道？" description="该渠道关联的模型选择会同时移除。" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => deleteChannel(channel.id)}>
                                            <Tooltip title="删除渠道"><Button className="size-10 p-0 sm:size-8" aria-label={`删除渠道 ${channel.name || "未命名渠道"}`} size="small" type="text" danger disabled={loadingChannelIds.includes(channel.id) || loadingChannelIds.includes("all")} icon={<Trash2 className="size-3.5" />} /></Tooltip>
                                        </Popconfirm>
                                    </div>
                                </div>
                                {editing && (
                                    <ModelEditorModal
                                        open
                                        title={channel.id === newChannelId ? "新增自定义渠道" : "编辑自定义渠道"}
                                        subtitle={channel.name}
                                        onClose={closeChannelEditor}
                                        footer={<div className="model-editor-footer">
                                            <span className="text-xs text-foreground/50">更改实时保存到云端渠道配置</span>
                                            <div className="model-editor-footer-actions">
                                                <Button loading={loadingChannelIds.includes(channel.id)} onClick={() => void refreshChannelModels(channel)}>拉取模型</Button>
                                                <Button type="primary" onClick={closeChannelEditor}>完成</Button>
                                            </div>
                                        </div>}
                                    >
                                        <div className="model-editor-panel">
                                            <section className="model-editor-section">
                                                <div>
                                                    <h2>连接信息</h2>
                                                    <p className="mt-1 text-xs text-foreground/50">用于拉取模型目录并向当前渠道发起请求。</p>
                                                </div>
                                                <div className="model-editor-connection-fields grid gap-3 sm:grid-cols-2">
                                                    <Form.Item label="渠道名称" htmlFor={`channel-${channel.id}-name`} className="mb-0 sm:col-span-1"><Input id={`channel-${channel.id}-name`} value={channel.name} placeholder="例如：我的 NewAPI" onChange={(event) => updateChannel(channel.id, { name: event.target.value })} onBlur={(event) => updateChannel(channel.id, { name: event.target.value.trim() || "未命名渠道" })} /></Form.Item>
                                                    <Form.Item label="目录连接类型" className="mb-0 sm:col-span-1" extra="仅影响模型目录拉取。"><Segmented<UserChannelConnection> block value={channelConnectionMode(channel)} options={[{ label: "OpenAI", value: "openai" }, { label: "Gemini", value: "gemini" }]} onChange={(value) => updateChannelConnection(channel, value)} /></Form.Item>
                                                    <Form.Item label="Base URL" htmlFor={`channel-${channel.id}-base-url`} className="mb-0 sm:col-span-1"><Input id={`channel-${channel.id}-base-url`} inputMode="url" value={channel.baseUrl} placeholder="填写云端渠道 Base URL" onChange={(event) => updateChannel(channel.id, { baseUrl: event.target.value })} onBlur={(event) => updateChannel(channel.id, { baseUrl: event.target.value.trim().replace(/\/+$/u, "") })} /></Form.Item>
                                                    <Form.Item label="API Key" htmlFor={`channel-${channel.id}-api-key`} className="mb-0 sm:col-span-1"><Input.Password id={`channel-${channel.id}-api-key`} autoComplete="new-password" value={channel.apiKey} placeholder={channel.apiFormat === "gemini" ? "填写 Gemini API Key" : "填写当前渠道 API Key"} onChange={(event) => updateChannel(channel.id, { apiKey: event.target.value })} onBlur={(event) => updateChannel(channel.id, { apiKey: event.target.value.trim() })} /></Form.Item>
                                                    <Form.Item label="Secret Key（可选）" htmlFor={`channel-${channel.id}-secret-key`} className="mb-0 sm:col-span-1" extra="即梦等 AK/SK 协议需要；其他协议留空。"><Input.Password id={`channel-${channel.id}-secret-key`} autoComplete="new-password" value={channel.secretKey || ""} placeholder="填写 Secret Key" onChange={(event) => updateChannel(channel.id, { secretKey: event.target.value })} onBlur={(event) => updateChannel(channel.id, { secretKey: event.target.value.trim() })} /></Form.Item>
                                                    <div className="sm:col-span-2"><ChannelHeadersEditor value={channel.headers} onChange={(headers) => updateChannel(channel.id, { headers })} /></div>
                                                </div>
                                            </section>
                                            <section className="model-editor-section">
                                                <div>
                                                    <h2>模型与能力</h2>
                                                    <p className="mt-1 text-xs text-foreground/50">维护渠道模型，并在单个模型中配置调用协议与能力。</p>
                                                </div>
                                                <Form.Item label="模型列表" htmlFor={`channel-${channel.id}-models`} className="mb-0"><Select id={`channel-${channel.id}-models`} mode="tags" showSearch allowClear maxTagCount="responsive" tokenSeparators={[",", "\n"]} placeholder="输入模型名，或点击拉取模型" value={channel.models} onChange={(models) => updateChannel(channel.id, { models: uniqueModels(models) })} /></Form.Item>
                                            </section>
                                        </div>
                                    </ModelEditorModal>
                                )}
                            </section>
                        );
                    })}
                </div>
            ) : <WorkspaceState icon="settings" compact title="还没有接入任何模型" description="填入你的 Base URL 和 API Key，拉取模型后就能在创作时直接选用。" action={<Button icon={<Plus className="size-4" />} onClick={() => setSystemEditor({ open: true, channel: null })}>新增接入</Button>} />}
        </Form>
        {managingSystemChannel ? (
            <ChannelModelManager
                channel={managingSystemChannel}
                autoFetch={autoFetchSystemModels}
                onClose={() => { setManagingSystemChannel(null); setAutoFetchSystemModels(false); }}
                onChanged={async () => { await refreshSystemChannels(); }}
                section={{ label: "模型渠道", path: "/settings?section=channels" }}
                backLabel="返回模型渠道"
            />
        ) : null}
        <SystemChannelEditorModal
            channel={systemEditor.channel}
            open={systemEditor.open}
            onClose={() => setSystemEditor({ open: false, channel: null })}
            onSaved={async (saved, intent) => {
                await refreshServerChannels();
                await refreshSystemChannels();
                if (intent !== "fetch") return;
                setAutoFetchSystemModels(true);
                setManagingSystemChannel(saved);
            }}
        />
        </>
    );
}

function WorkflowChannelEntry({ icon, title, description, status, ready, onOpen }: { icon: ReactNode; title: string; description: string; status: string; ready: boolean; onOpen?: () => void }) {
    return (
        <div className="settings-channel flex min-w-0 items-center justify-between gap-3 p-3">
            <div className="flex min-w-0 items-start gap-2.5">
                <span className="mt-0.5 shrink-0 text-[var(--workspace-accent)]" aria-hidden="true">{icon}</span>
                <div className="min-w-0">
                    <h4 className="text-sm font-semibold">{title}</h4>
                    <p className="mt-0.5 truncate text-xs text-foreground/55">{description}</p>
                    <span className={`settings-channel-status mt-1.5 ${ready ? "is-ready" : "is-warning"}`}><i aria-hidden="true" />{status}</span>
                </div>
            </div>
            <Button size="small" onClick={onOpen} disabled={!onOpen}>配置</Button>
        </div>
    );
}

export function channelValidationError(channel: ModelChannel) {
    return channelConnectionError(channel) || validateChannelHeaders(channel.headers) || (!channel.models.length ? "请添加至少一个模型" : "");
}

export function isChannelReady(channel: ModelChannel) {
    return !channelValidationError(channel);
}

export function focusInvalidChannelField(channel: ModelChannel) {
    const baseUrlError = channelConnectionError({ ...channel, apiKey: "valid", secretKey: "valid" });
    const field = baseUrlError ? "base-url" : !channel.apiKey.trim() ? "api-key" : requiresSecretKey(channel) && !channel.secretKey?.trim() ? "secret-key" : "models";
    requestAnimationFrame(() => {
        const element = document.getElementById(`channel-${channel.id}-${field}`);
        element?.scrollIntoView({ behavior: "smooth", block: "center" });
        element?.focus({ preventScroll: true });
    });
}

function ChannelStatus({ channel }: { channel: ModelChannel }) {
    const error = channelValidationError(channel);
    return (
        <span className={`settings-channel-status ${error ? "is-warning" : "is-ready"}`}>
            <i aria-hidden="true" />
            {error || "可用"}
        </span>
    );
}

function withChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    const models = modelOptionsFromChannels(channels);
    const imageModels = filterModelsByCapability(models, "image", channels);
    const videoModels = filterModelsByCapability(models, "video", channels);
    const textModels = filterModelsByCapability(models, "text", channels);
    const audioModels = filterModelsByCapability(models, "audio", channels);
    return { ...config, channels, models, baseUrl: channels[0]?.baseUrl || config.baseUrl, apiKey: channels[0]?.apiKey || config.apiKey, apiFormat: channels[0]?.apiFormat || config.apiFormat, imageModels, videoModels, textModels, audioModels, imageModel: normalizeDefaultModel(config.imageModel, imageModels), videoModel: normalizeDefaultModel(config.videoModel, videoModels), textModel: normalizeDefaultModel(config.textModel, textModels), audioModel: normalizeDefaultModel(config.audioModel, audioModels) };
}

function normalizeDefaultModel(value: string, options: string[]) {
    return options.includes(value) ? value : options[0] || "";
}

function uniqueModels(models: string[]) {
    return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}

function channelModelFetchErrorMessage(error: unknown) {
    const detail = error instanceof Error ? error.message : "读取模型失败";
    if (detail.includes("不允许访问本机") || detail.includes("不允许访问保留地址")) return `${detail}；可信私网服务需由部署管理员配置 CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS`;
    return `${detail}；也可以直接在模型列表中手动输入模型名`;
}

function channelConnectionMode(channel: ModelChannel): UserChannelConnection {
    return channel.apiFormat === "gemini" ? "gemini" : "openai";
}

function channelConnectionError(channel: ModelChannel) {
    const baseUrl = channel.baseUrl.trim();
    if (!baseUrl) return "请填写 Base URL";
    try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Base URL 只支持 HTTP 或 HTTPS";
    } catch {
        return "Base URL 格式不正确";
    }
    if (!channel.apiKey.trim()) return "请填写 API Key / Access Key";
    if (requiresSecretKey(channel) && !channel.secretKey?.trim()) return "当前协议需要填写 Secret Key";
    return "";
}

function channelConnectionSignature(channel: ModelChannel) {
    return [channel.baseUrl.trim(), channel.apiKey.trim(), channel.secretKey?.trim() || "", channel.apiFormat, JSON.stringify(channel.headers || [])].join("\n");
}

function channelProtocolLabel(channel: ModelChannel) {
    return channelConnectionMode(channel) === "gemini" ? "Gemini 原生" : "OpenAI 兼容";
}

function isKnownDefaultBaseUrl(value: string) {
    const normalized = value.trim().replace(/\/+$/, "");
    if (!normalized) return true;
    return [defaultBaseUrlForApiFormat("openai"), defaultBaseUrlForApiFormat("gemini")].some((candidate) => candidate.replace(/\/+$/, "") === normalized);
}

function requiresSecretKey(channel: ModelChannel) {
    return channel.modelCosts?.some((item) => item.protocol?.startsWith("volcengine-jimeng-")) === true;
}
