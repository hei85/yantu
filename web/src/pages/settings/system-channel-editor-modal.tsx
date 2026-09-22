import { App, Button, Form, Input, Switch } from "antd";
import { useEffect, useState } from "react";

import { ChannelHeadersEditor, validateChannelHeaders } from "@/components/channel-headers-editor";
import { ModelEditorModal } from "@/components/model-editor-modal";
import { createAdminChannel, updateAdminChannel } from "@/services/api/auth";
import { type ChannelHeader, type ModelChannel } from "@/stores/use-config-store";

type Props = {
    channel: ModelChannel | null;
    open: boolean;
    onClose: () => void;
    // intent=fetch 表示保存后立即打开模型管理并拉取上游模型。
    onSaved: (saved: ModelChannel, intent: "done" | "fetch") => void | Promise<void>;
};

// 平台渠道存在服务端、所有创作共用；这里只维护连接信息，
// 模型与能力交给同一个入口里的「模型管理」，避免两处配置互相覆盖。
export function SystemChannelEditorModal({ channel, open, onClose, onSaved }: Props) {
    const { message } = App.useApp();
    const [form] = Form.useForm<{ name: string; baseUrl: string; apiKey: string; enabled: boolean }>();
    const [headers, setHeaders] = useState<ChannelHeader[]>([]);
    const [saving, setSaving] = useState(false);

    // 弹窗内容会被销毁重建，initialValues 必须随每次打开重新计算。
    const initialValues = {
        name: channel?.name || "",
        baseUrl: channel?.baseUrl || "",
        apiKey: "",
        enabled: channel?.enabled !== false,
    };

    useEffect(() => {
        if (!open) return;
        form.setFieldsValue({
            name: channel?.name || "",
            baseUrl: channel?.baseUrl || "",
            apiKey: "",
            enabled: channel?.enabled !== false,
        });
        setHeaders(Array.isArray(channel?.headers) ? channel.headers : []);
    }, [channel, form, open]);

    const save = async (intent: "done" | "fetch" = "done") => {
        let values: { name: string; baseUrl: string; apiKey: string; enabled: boolean };
        try {
            values = await form.validateFields();
        } catch {
            return;
        }
        const headerError = validateChannelHeaders(headers);
        if (headerError) {
            message.error(headerError);
            return;
        }
        const apiKey = String(values.apiKey || "").trim();
        if (!channel && !apiKey) {
            message.error("请填写 API Key");
            return;
        }
        setSaving(true);
        try {
            const payload = {
                name: values.name.trim() || "未命名渠道",
                baseUrl: String(values.baseUrl || "").trim().replace(/\/+$/u, ""),
                headers,
                enabled: values.enabled !== false,
                ...(apiKey ? { apiKey } : {}),
            };
            const saved = channel ? (await updateAdminChannel(channel.id, payload)).channel : (await createAdminChannel(payload)).channel;
            await onSaved(saved, intent);
            message.success(channel ? "模型接入已更新，现在可以拉取模型" : "模型接入已创建，现在可以拉取模型");
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存模型接入失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <ModelEditorModal
            key={`${open ? "open" : "closed"}-${channel?.id ?? "new"}`}
            open={open}
            title={channel ? "编辑模型接入" : "新增模型接入"}
            subtitle={channel?.name}
            onClose={onClose}
            footer={
                <div className="model-editor-footer">
                    <span className="text-xs text-foreground/50">保存在服务端，所有创作共用</span>
                    <div className="model-editor-footer-actions">
                        <Button onClick={onClose}>取消</Button>
                        <Button loading={saving} onClick={() => void save("done")}>保存</Button>
                        <Button type="primary" loading={saving} onClick={() => void save("fetch")}>保存并拉取模型</Button>
                    </div>
                </div>
            }
        >
            <div className="model-editor-panel">
            <Form form={form} layout="vertical" requiredMark={false} initialValues={initialValues}>
                <section className="model-editor-section">
                    <div>
                        <h2>连接信息</h2>
                        <p className="mt-1 text-xs text-foreground/50">只填到域名，不要带 /v1、/v1/videos 这类接口路径。点「保存并拉取模型」会先保存，再直接列出上游模型供你勾选。</p>
                    </div>
                    <div className="model-editor-connection-fields grid gap-3 sm:grid-cols-2">
                        <Form.Item name="name" label="名称" className="mb-0">
                            <Input placeholder="例如：我的中转站" />
                        </Form.Item>
                        <Form.Item name="baseUrl" label="Base URL" className="mb-0" rules={[{ required: true, message: "请填写 Base URL" }]}>
                            <Input inputMode="url" placeholder="https://api.example.com" />
                        </Form.Item>
                        <Form.Item
                            name="apiKey"
                            label={channel?.hasApiKey ? "API Key（已配置 · 留空不改）" : "API Key"}
                            className="mb-0"
                            rules={channel ? [] : [{ required: true, message: "请填写 API Key" }]}
                        >
                            <Input.Password autoComplete="new-password" placeholder={channel ? "留空保留原凭证" : "填写 API Key"} />
                        </Form.Item>
                        <Form.Item name="enabled" label="启用" valuePropName="checked" className="mb-0">
                            <Switch />
                        </Form.Item>
                        <div className="sm:col-span-2">
                            <ChannelHeadersEditor value={headers} onChange={setHeaders} />
                        </div>
                    </div>
                </section>
            </Form>
            </div>
        </ModelEditorModal>
    );
}
