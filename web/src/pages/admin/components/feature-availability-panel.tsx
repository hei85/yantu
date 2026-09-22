import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { App, Button, Skeleton } from "antd";
import { Switch } from "@/pages/admin/ui/controls";
import { AlertTriangle, Clapperboard, ListChecks, MonitorCog, PlugZap, RadioTower, RefreshCw, ShieldCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import { getAdminFeatureAvailability, updateAdminFeatureAvailability } from "@/services/api/auth";
import { useUserStore, type FeatureAvailability } from "@/stores/use-user-store";
import { AdminStatusBadge } from "./admin-ui";

type FeatureKey = "shortDramaEnabled" | "taskCenterEnabled" | "customChannelsEnabled" | "frontendModelsEnabled" | "pluginCenterEnabled" | "systemPluginsVisibleToUsers";
type FeatureRow = {
    key: FeatureKey;
    title: string;
    description: string;
    icon: ReactNode;
    dependsOn?: FeatureKey;
};

const editableFeatureKeys: FeatureKey[] = ["shortDramaEnabled", "taskCenterEnabled", "customChannelsEnabled", "frontendModelsEnabled", "pluginCenterEnabled", "systemPluginsVisibleToUsers"];

const workspaceFeatureRows: FeatureRow[] = [
    {
        key: "shortDramaEnabled",
        title: "短剧创作",
        description: "开放短剧入口、项目列表与项目详情。关闭不删除已有项目。",
        icon: <Clapperboard className="size-4" aria-hidden="true" />,
    },
    {
        key: "taskCenterEnabled",
        title: "任务中心",
        description: "开放任务记录页面。关闭不会停止生成任务。",
        icon: <ListChecks className="size-4" aria-hidden="true" />,
    },
    {
        key: "customChannelsEnabled",
        title: "自己的模型 API",
        description: "允许在设置里接入自己的模型服务（Base URL / API Key / 模型名）。",
        icon: <RadioTower className="size-4" aria-hidden="true" />,
    },
];

const pluginFeatureRows: FeatureRow[] = [
    {
        key: "pluginCenterEnabled",
        title: "插件中心",
        description: "开放插件中心及插件调用能力。",
        icon: <PlugZap className="size-4" aria-hidden="true" />,
    },
    {
        key: "systemPluginsVisibleToUsers",
        title: "系统插件可见性",
        description: "向普通用户展示系统协议插件和管理员上传插件。",
        icon: <ShieldCheck className="size-4" aria-hidden="true" />,
        dependsOn: "pluginCenterEnabled",
    },
];

// 本地单用户工作站只保留创作相关开关。
const allFeatureRows = [...workspaceFeatureRows, ...pluginFeatureRows];
const featureByKey = new Map(allFeatureRows.map((item) => [item.key, item]));

export default function FeatureAvailabilityPanel() {
    const { message, modal } = App.useApp();
    const setGlobalFeatures = useUserStore((state) => state.setFeatures);
    const [savedFeatures, setSavedFeatures] = useState<FeatureAvailability | null>(null);
    const [draftFeatures, setDraftFeatures] = useState<FeatureAvailability | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [saveError, setSaveError] = useState("");
    const requestVersionRef = useRef(0);

    const load = useCallback(
        async (initial = false, announce = false) => {
            const requestVersion = ++requestVersionRef.current;
            if (initial) setLoading(true);
            else setRefreshing(true);
            setLoadError("");
            try {
                const result = await getAdminFeatureAvailability();
                const value = parseFeatureAvailability(result.features);
                if (requestVersion !== requestVersionRef.current) return;
                setSavedFeatures(value);
                setDraftFeatures(value);
                setGlobalFeatures(value);
                setSaveError("");
                if (announce) message.success("已重新读取当前功能状态");
            } catch (error) {
                if (requestVersion !== requestVersionRef.current) return;
                const errorMessage = error instanceof Error ? error.message : "读取功能开放配置失败";
                setLoadError(errorMessage);
                if (!initial) message.error(errorMessage);
            } finally {
                if (requestVersion === requestVersionRef.current) {
                    setLoading(false);
                    setRefreshing(false);
                }
            }
        },
        [message, setGlobalFeatures],
    );

    useEffect(() => {
        void load(true);
        return () => {
            requestVersionRef.current += 1;
        };
    }, [load]);

    const setFeature = async (key: FeatureKey, enabled: boolean) => {
        if (!savedFeatures || saving || savedFeatures[key] === enabled) return;
        const previous = savedFeatures;
        const expected = { ...savedFeatures, [key]: enabled };
        setDraftFeatures(expected);
        setSaving(true);
        setSaveError("");
        try {
            const result = await updateAdminFeatureAvailability(toEditablePayload(expected));
            const value = parseFeatureAvailability(result.features);
            if (!sameEditableFeatures(value, expected)) throw new Error("服务端返回的功能状态与本次保存内容不一致，请重新读取后核对");
            setSavedFeatures(value);
            setDraftFeatures(value);
            setGlobalFeatures(value);
            message.success(`${featureByKey.get(key)?.title || "功能"}已${enabled ? "开启" : "关闭"}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "保存功能开放配置失败";
            setDraftFeatures(previous);
            setSaveError(`${errorMessage}。已恢复修改前状态。`);
            message.error(errorMessage);
        } finally {
            setSaving(false);
        }
    };

    const requestFeatureChange = (key: FeatureKey, enabled: boolean) => {
        if (!savedFeatures || saving || savedFeatures[key] === enabled) return;
        // 关闭工作台入口属于高风险操作，需要二次确认。
        if (key === "shortDramaEnabled" && !enabled) {
            modal.confirm({
                title: "关闭短剧创作？",
                content: "保存后短剧入口、项目列表与项目详情将不再展示；已有项目数据不会删除，重新开启后即可继续使用。",
                okText: "确认关闭",
                cancelText: "取消",
                okButtonProps: { danger: true },
                onOk: () => setFeature(key, false),
            });
            return;
        }
        void setFeature(key, enabled);
    };

    if (loading && !draftFeatures) {
        return (
            <div className="admin-settings-stack admin-feature-availability" aria-label="正在读取功能开放配置" role="status">
                <div className="admin-feature-command-bar">
                    <Skeleton active title={{ width: 180 }} paragraph={false} />
                </div>
                <div className="admin-feature-board is-loading">
                    {Array.from({ length: 3 }).map((_, index) => (
                        <div key={index} className="admin-feature-domain">
                            <Skeleton active title={{ width: 120 }} paragraph={{ rows: 3 }} />
                        </div>
                    ))}
                </div>
                <div className="admin-feature-loading-card">
                    <Skeleton active paragraph={{ rows: 2 }} />
                </div>
            </div>
        );
    }

    if (!draftFeatures || !savedFeatures) {
        return (
            <div className="admin-settings-stack admin-feature-availability">
                <div className="admin-feature-load-error" role="alert">
                    <span className="admin-feature-load-error-icon">
                        <AlertTriangle className="size-5" aria-hidden="true" />
                    </span>
                    <div>
                        <h2>无法读取功能开放配置</h2>
                        <p>{loadError || "当前没有可显示的配置，请稍后重试。"}</p>
                    </div>
                    <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load(true)}>
                        重新读取
                    </Button>
                </div>
            </div>
        );
    }

    const enabledWorkspaceFeatures = workspaceFeatureRows.filter((row) => effectiveFeatureValue(draftFeatures, row.key)).length;
    const enabledPluginFeatures = pluginFeatureRows.filter((row) => effectiveFeatureValue(draftFeatures, row.key)).length;

    return (
        <div className="admin-settings-stack admin-feature-availability">
            <div className="admin-feature-command-bar">
                <div className="admin-feature-command-copy" aria-live="polite">
                    <div className="flex flex-wrap items-center gap-2">
                        <strong>{saving ? "正在保存更改" : "开关切换后立即生效"}</strong>
                        <AdminStatusBadge label={saving ? "提交中" : savedFeatures.configured ? "服务端配置" : "系统默认"} tone={saving ? "warning" : "neutral"} />
                    </div>
                </div>
                <div className="admin-feature-command-actions">
                    <Button icon={<RefreshCw className="size-4" />} loading={refreshing} disabled={saving} onClick={() => void load(false, true)}>
                        刷新状态
                    </Button>
                </div>
            </div>

            {loadError || saveError ? (
                <div className="admin-feature-inline-alert" role="alert">
                    <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                    <span>{saveError || `${loadError}。页面仍显示上一次成功读取的状态。`}</span>
                </div>
            ) : null}

            <div className="admin-feature-board" aria-label="功能开放控制台">
                <FeatureDomainPanel
                    title="1. 用户工作台入口"
                    description="先决定普通用户能进入哪些核心工作区"
                    icon={<MonitorCog className="size-4" aria-hidden="true" />}
                    status={<AdminStatusBadge label={`${enabledWorkspaceFeatures}/${workspaceFeatureRows.length} 开放`} tone={enabledWorkspaceFeatures === workspaceFeatureRows.length ? "success" : "neutral"} />}
                >
                    {workspaceFeatureRows.map((row) => (
                        <FeatureSettingRow key={row.key} row={row} saved={savedFeatures} draft={draftFeatures} saving={saving} onChange={requestFeatureChange} />
                    ))}
                </FeatureDomainPanel>

                <FeatureDomainPanel
                    title="2. 插件开放范围"
                    description="先开放插件中心，再决定系统插件是否可见"
                    icon={<PlugZap className="size-4" aria-hidden="true" />}
                    status={<AdminStatusBadge label={`${enabledPluginFeatures}/2 生效`} tone={enabledPluginFeatures === 2 ? "success" : "neutral"} />}
                >
                    <FeatureSettingRow row={pluginFeatureRows[0]} saved={savedFeatures} draft={draftFeatures} saving={saving} onChange={requestFeatureChange} step={1} />
                    {draftFeatures.pluginCenterEnabled ? <FeatureSettingRow row={pluginFeatureRows[1]} saved={savedFeatures} draft={draftFeatures} saving={saving} onChange={requestFeatureChange} step={2} /> : null}
                </FeatureDomainPanel>

            </div>
        </div>
    );
}

function FeatureDomainPanel({ title, description, icon, status, children }: { title: string; description: string; icon: ReactNode; status: ReactNode; children: ReactNode }) {
    return (
        <section className="admin-feature-domain">
            <header className="admin-feature-domain-header">
                <span className="admin-feature-domain-icon">{icon}</span>
                <div className="admin-feature-domain-copy min-w-0 flex-1">
                    <h2>{title}</h2>
                    <p>{description}</p>
                </div>
                <div className="admin-feature-domain-status">{status}</div>
            </header>
            <div className="admin-feature-domain-list">{children}</div>
        </section>
    );
}

function FeatureSettingRow({ row, saved, draft, saving, onChange, step }: { row: FeatureRow; saved: FeatureAvailability; draft: FeatureAvailability; saving: boolean; onChange: (key: FeatureKey, enabled: boolean) => void; step?: number }) {
    const changed = saved[row.key] !== draft[row.key];
    const dependencyDisabled = Boolean(row.dependsOn && !draft[row.dependsOn]);
    const enabled = effectiveFeatureValue(draft, row.key);

    return (
        <article className={cn("admin-feature-board-row", changed && "is-dirty", !enabled && "is-off", row.dependsOn && "is-dependent")}>
            <div className="admin-feature-board-row-copy">
                <span className="admin-feature-board-row-icon">{row.icon}</span>
                <span className="admin-feature-board-row-name">
                    {step ? <small>第 {step} 步</small> : null}
                    <strong>{row.title}</strong>
                    <span>{row.description}</span>
                </span>
                {changed ? <span className="admin-feature-board-row-dirty">待保存</span> : null}
            </div>
            <div className="admin-feature-board-row-control">
                <span>{dependencyDisabled ? "依赖未开启" : enabled ? "已开放" : "已关闭"}</span>
                <Switch checked={draft[row.key]} disabled={saving || dependencyDisabled} onChange={(checked) => onChange(row.key, checked)} aria-label={`设置${row.title}，切换后立即保存`} />
            </div>
        </article>
    );
}

function effectiveFeatureValue(features: FeatureAvailability, key: FeatureKey) {
    if (key === "systemPluginsVisibleToUsers") return features.pluginCenterEnabled && features.systemPluginsVisibleToUsers;
    return features[key];
}

function toEditablePayload(features: FeatureAvailability) {
    return {
        shortDramaEnabled: features.shortDramaEnabled,
        taskCenterEnabled: features.taskCenterEnabled,
        customChannelsEnabled: features.customChannelsEnabled,
        frontendModelsEnabled: features.frontendModelsEnabled,
        pluginCenterEnabled: features.pluginCenterEnabled,
        systemPluginsVisibleToUsers: features.systemPluginsVisibleToUsers,
    };
}

function sameEditableFeatures(left: FeatureAvailability, right: FeatureAvailability) {
    return editableFeatureKeys.every((key) => left[key] === right[key]);
}

function parseFeatureAvailability(value: unknown): FeatureAvailability {
    if (!value || typeof value !== "object") throw new Error("功能开放配置响应格式无效");
    const record = value as Record<string, unknown>;
    for (const key of editableFeatureKeys) {
        if (typeof record[key] !== "boolean") throw new Error("功能开放配置响应缺少有效开关状态");
    }
    return {
        welcomeEnabled: record.welcomeEnabled as boolean,
        shortDramaEnabled: record.shortDramaEnabled as boolean,
        taskCenterEnabled: record.taskCenterEnabled as boolean,
        customChannelsEnabled: record.customChannelsEnabled as boolean,
        frontendModelsEnabled: record.frontendModelsEnabled as boolean,
        pluginCenterEnabled: record.pluginCenterEnabled as boolean,
        systemPluginsVisibleToUsers: record.systemPluginsVisibleToUsers as boolean,
        configured: typeof record.configured === "boolean" ? record.configured : undefined,
        updatedBy: typeof record.updatedBy === "string" ? record.updatedBy : undefined,
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
    };
}
