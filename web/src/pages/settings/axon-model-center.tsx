// SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
import { App, Button, Input, Spin } from "antd";
import { useCallback, useEffect, useState } from "react";
import { AXON_BASE_URL, isAxonBaseUrl } from "@/lib/distribution-policy";
import { refreshSystemChannels } from "@/lib/user-session";
import { createAdminChannel, listAdminChannels, updateAdminChannel } from "@/services/api/auth";
import { useConfigStore, useEffectiveConfig, type ModelChannel } from "@/stores/use-config-store";
import { ChannelModelManager } from "@/pages/admin/components/channel-model-manager";
import { ModelDefaultGrid } from "./model-default-grid";

export function AxonModelCenter() {
    const { message } = App.useApp();
    const [channels, setChannels] = useState<ModelChannel[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [apiKey, setApiKey] = useState("");
    const [managing, setManaging] = useState<ModelChannel | null>(null);
    const [autoFetch, setAutoFetch] = useState(false);
    const config = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const reload = useCallback(async () => {
        setLoading(true);
        try {
            const result = await listAdminChannels({ page: 1, pageSize: 100 });
            setChannels(result.channels.filter((item) => isAxonBaseUrl(item.baseUrl)));
            await refreshSystemChannels();
        } catch (error) { message.error(error instanceof Error ? error.message : "读取 Axon 配置失败"); }
        finally { setLoading(false); }
    }, [message]);
    useEffect(() => { void reload(); }, [reload]);
    const save = async () => {
        if (!apiKey.trim()) { message.error("请填写你自己的 Axon API Key"); return; }
        setSaving(true);
        try {
            const payload = { name: "Axon", baseUrl: AXON_BASE_URL, apiKey: apiKey.trim(), enabled: true, headers: [] };
            const result = channels[0] ? await updateAdminChannel(channels[0].id, payload) : await createAdminChannel(payload);
            setApiKey("");
            await reload();
            setAutoFetch(true);
            setManaging(result.channel);
            message.success("Axon 连接已保存，请选择需要导入的模型");
        } catch (error) { message.error(error instanceof Error ? error.message : "保存 Axon 配置失败"); }
        finally { setSaving(false); }
    };
    if (managing) return <ChannelModelManager channel={managing} autoFetch={autoFetch} backLabel="返回 Axon 模型中心" onClose={() => { setManaging(null); void reload(); }} onChanged={reload} />;
    return (
        <div className="settings-pane model-setup-pane">
            <header className="settings-pane-header"><div><h2>Axon 模型中心</h2><p>此发行版通过 Axon 提供文本、图片、视频和音频模型。新模型从 Axon 目录拉取并导入。</p></div></header>
            <section className="model-editor-section">
                <h3>连接 Axon</h3>
                <label className="block text-sm" htmlFor="axon-endpoint">服务地址</label><Input id="axon-endpoint" value={AXON_BASE_URL} readOnly />
                <label className="mt-3 block text-sm" htmlFor="axon-key">API Key{channels[0]?.hasApiKey ? "（已配置）" : ""}</label>
                <Input.Password id="axon-key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" placeholder="填写你自己的 Axon API Key" />
                <div className="mt-3 flex flex-wrap gap-2"><Button type="primary" loading={saving} onClick={() => void save()}>保存并拉取模型</Button><Button loading={loading} onClick={() => void reload()}>刷新配置</Button></div>
            </section>
            {loading ? <Spin /> : channels.map((channel) => <section className="model-editor-section" key={channel.id}>
                <h3>{channel.name}</h3><p>{channel.hasApiKey ? "凭证已保存在本机服务端" : "请先配置 API Key"}</p>
                <Button onClick={() => { setAutoFetch(false); setManaging(channel); }}>管理 Axon 模型</Button>
                <Button className="ml-2" onClick={() => { setAutoFetch(true); setManaging(channel); }}>从 Axon 拉取新模型</Button>
            </section>)}
            <section className="model-editor-section"><h3>创作默认</h3><ModelDefaultGrid config={config} onChange={(key, model) => updateConfig(key as Parameters<typeof updateConfig>[0], model)} /></section>
        </div>
    );
}
