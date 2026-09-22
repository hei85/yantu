import { App, Button, InputNumber } from "antd";
import { SettingsRow } from "@/components/ui/product/settings-row";
import { ArrowLeft, Boxes, Bug, KeyRound, MessageSquareText, Paintbrush, RadioTower, SlidersHorizontal, ToggleLeft, Zap } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { refreshSystemChannels } from "@/lib/user-session";
import { defaultConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { ChannelSettingsPane, channelValidationError, focusInvalidChannelField, isChannelReady } from "./channel-settings-pane";
import { ModelDefaultGrid } from "./model-default-grid";
import { PromptPreferencesPane } from "./prompt-preferences-pane";
import { ModelQuickConnectPane } from "./model-quick-connect-pane";
import DiagnosticsPanel from "./diagnostics-panel";
import { DrawingEnginePane, FeatureAvailabilityPane, PromptTemplatesPane, ThirdPartySettingsPane } from "./system-settings-pane";

type ConfigSectionKey =
    | "quick"
    | "channels"
    | "models"
    | "preferences"
    | "prompts"
    | "diagnostics"
    // 原管理后台页面并入设置后的系统分区。
    | "prompt-templates"
    | "features"
    | "drawing-engine"
    | "third-party";

type ConfigSection = { key: ConfigSectionKey; label: string; description: string; icon: ReactNode; group: "创作设置" | "系统"; };

const configSections: ConfigSection[] = [
    { key: "quick", label: "快速接入", description: "只填 API 地址、API Key 和模型名", icon: <Zap className="size-4" />, group: "创作设置" },
    { key: "channels", label: "模型接入", description: "接入你自己的模型 API", icon: <RadioTower className="size-4" />, group: "创作设置" },
    { key: "models", label: "模型选择", description: "按领域选择默认模型", icon: <Boxes className="size-4" />, group: "创作设置" },
    { key: "preferences", label: "生成偏好", description: "画布生成默认值", icon: <SlidersHorizontal className="size-4" />, group: "创作设置" },
    { key: "prompts", label: "提示词偏好", description: "按任务定制平台模板", icon: <MessageSquareText className="size-4" />, group: "创作设置" },
    { key: "diagnostics", label: "问题诊断", description: "导出日志协助排查", icon: <Bug className="size-4" />, group: "创作设置" },
    { key: "prompt-templates", label: "提示词模板", description: "平台创作策略版本", icon: <MessageSquareText className="size-4" />, group: "系统" },
    { key: "features", label: "功能开放", description: "工作台入口与插件开放范围", icon: <ToggleLeft className="size-4" />, group: "系统" },
    { key: "drawing-engine", label: "绘图工具", description: "画布绘图节点默认引擎", icon: <Paintbrush className="size-4" />, group: "系统" },
    { key: "third-party", label: "第三方参数配置", description: "第三方凭据与集成参数", icon: <KeyRound className="size-4" />, group: "系统" },
];

export function isConfigSection(value: string | null): value is ConfigSectionKey {
    return configSections.some((section) => section.key === value);
}

export default function SettingsPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const requestedSection = searchParams.get("section");
    const customChannelsEnabled = useUserStore((state) => state.features.customChannelsEnabled);
    const initialSection = isConfigSection(requestedSection) ? requestedSection : customChannelsEnabled ? "quick" : "models";
    const [activeTab, setActiveTab] = useState<ConfigSectionKey>(initialSection === "channels" && !customChannelsEnabled ? "models" : initialSection);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const shouldPromptContinue = searchParams.get("continue") === "1";
    const userId = useUserStore((state) => state.user?.id);
    const userChannels = config.channels.filter((channel) => channel.scope !== "system");
    const visibleConfigSections = useMemo(() => (customChannelsEnabled ? configSections : configSections.filter((section) => section.key !== "channels")), [customChannelsEnabled]);

    const isVisibleConfigSection = (value: string | null): value is ConfigSectionKey => isConfigSection(value) && visibleConfigSections.some((section) => section.key === value);

    useLayoutEffect(() => {
        document.body.classList.add("app-user-overlays");
        return () => document.body.classList.remove("app-user-overlays");
    }, []);

    useEffect(() => {
        if (isVisibleConfigSection(requestedSection)) {
            setActiveTab(requestedSection);
            return;
        }
        setActiveTab((current) => visibleConfigSections.some((section) => section.key === current) ? current : customChannelsEnabled ? "quick" : "models");
    }, [customChannelsEnabled, requestedSection, visibleConfigSections]);

    useEffect(() => {
        if (!userId) return;
        let cancelled = false;
        void refreshSystemChannels().catch((error) => {
            if (!cancelled) message.warning(error instanceof Error ? `系统模型刷新失败：${error.message}` : "系统模型刷新失败，继续使用本地缓存");
        });
        return () => {
            cancelled = true;
        };
    }, [message, userId]);

    const selectSection = (section: ConfigSectionKey) => {
        setActiveTab(section);
        const next = new URLSearchParams(searchParams);
        next.set("section", section);
        setSearchParams(next, { replace: true });
    };

    const finishConfig = () => {
        const invalidChannel = customChannelsEnabled ? userChannels.find((channel) => channelValidationError(channel)) : undefined;
        if (invalidChannel) {
            selectSection("channels");
            message.warning(`${invalidChannel.name || "未命名渠道"}：${channelValidationError(invalidChannel)}`);
            focusInvalidChannelField(invalidChannel);
            return;
        }
        if (!effectiveConfig.channels.some(isChannelReady)) {
            selectSection(customChannelsEnabled ? "channels" : "models");
            message.error(customChannelsEnabled ? (shouldPromptContinue ? "请先完成至少一个渠道的 Base URL、API Key 和模型配置" : "当前没有可用渠道，请先完成连接信息和模型配置") : "当前没有可用的系统模型，请联系管理员配置系统渠道");
            return;
        }
        message.success("配置已保存，正在返回创作页面");
        navigate(-1);
    };

    const panes: Record<ConfigSectionKey, ReactNode> = {
        quick: <SettingsPane><ModelQuickConnectPane onOpenAdvanced={() => selectSection("channels")} /></SettingsPane>,
        channels: <SettingsPane><ChannelSettingsPane onOpenModels={() => selectSection("models")} /></SettingsPane>,
        models: (
            <SettingsPane>
                <div className="settings-pane-header">
                    <div className="min-w-0">
                        <h2>模型选择</h2>
                        <p>按领域选择默认模型；模型能力与请求协议在渠道“模型与能力”中配置。</p>
                    </div>
                </div>
                <div className="settings-section">
                    <ModelDefaultGrid config={effectiveConfig} onChange={(key, model) => updateConfig(key, model)} />
                </div>
            </SettingsPane>
        ),
        preferences: (
            <SettingsPane>
                <div className="settings-pane-header">
                    <div className="min-w-0">
                        <h2>生成偏好</h2>
                        <p>设置新建生成任务时使用的初始值，节点内仍可单独覆盖。</p>
                    </div>
                </div>
                <div className="settings-section">
                    <section className="settings-preference-block">
                        <div className="settings-preference-heading">
                            <h3>画布生成</h3>
                            <p>用于新建图片生成任务，节点内仍可单独覆盖。</p>
                        </div>
                        <SettingsRow
                            label="默认生图张数"
                            control={
                                <InputNumber
                                    min={1}
                                    max={15}
                                    precision={0}
                                    className="w-full"
                                    value={Number(config.canvasImageCount)}
                                    onChange={(value) => updateConfig("canvasImageCount", normalizeImageCount(String(value ?? defaultConfig.canvasImageCount)))}
                                />
                            }
                            controlClassName="w-[200px]"
                        />
                    </section>
                </div>
            </SettingsPane>
        ),
        prompts: <SettingsPane fill><PromptPreferencesPane /></SettingsPane>,
        diagnostics: <SettingsPane><DiagnosticsPanel taskId={searchParams.get("taskId") || undefined} projectId={searchParams.get("projectId") || undefined} /></SettingsPane>,
        "prompt-templates": <PromptTemplatesPane />,
        features: <FeatureAvailabilityPane />,
        "drawing-engine": <DrawingEnginePane />,
        "third-party": <ThirdPartySettingsPane />,
    };

    return (
        <main className="settings-page app-workspace-page app-user-workspace flex h-full min-h-0 flex-col text-foreground">
            {shouldPromptContinue ? (
                <div className="settings-topbar shrink-0">
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                        <Button icon={<ArrowLeft className="size-4" />} onClick={() => navigate(-1)}>返回创作</Button>
                        <Button type="primary" onClick={finishConfig}>保存并返回</Button>
                    </div>
                </div>
            ) : null}
            <div className="settings-library-frame flex min-h-0 flex-1 flex-col md:flex-row">
                <aside className="settings-nav-panel w-full shrink-0 md:w-[200px]">
                    <nav className="thin-scrollbar flex gap-1 overflow-x-auto p-2 md:block md:space-y-1 md:p-2.5" aria-label="配置分类">
                        {visibleConfigSections.map((item, index) => {
                            const selected = item.key === activeTab;
                            return (
                                <Fragment key={item.key}>
                                    {item.group !== visibleConfigSections[index - 1]?.group ? <span className="settings-nav-group-label">{item.group}</span> : null}
                                <button
                                    type="button"
                                    className={`settings-nav-item flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-auto md:w-full md:items-start md:gap-3 md:py-2.5 ${selected ? "is-active" : "text-foreground/58 hover:bg-muted/55 hover:text-foreground"}`}
                                    onClick={() => selectSection(item.key)}
                                    aria-current={selected ? "page" : undefined}
                                >
                                    <span className={`shrink-0 md:mt-0.5 ${selected ? "text-[var(--workspace-accent)]" : ""}`}>{item.icon}</span>
                                    <span className="min-w-0">
                                        <span className="block whitespace-nowrap text-sm font-medium">{item.label}</span>
                                        <span className="mt-1 hidden text-[var(--fs-label)] leading-4 text-current opacity-65 md:block">{item.description}</span>
                                    </span>
                                </button>
                                </Fragment>
                            );
                        })}
                    </nav>
                </aside>
                <section className="settings-content flex min-h-0 min-w-0 flex-1 flex-col">
                    <div className="app-workspace-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 md:px-6 md:py-5">
                        <div className={`settings-pane-root ${activeTab === "prompts" ? "h-full w-full" : "mx-auto w-full max-w-none"}`}>
                            {panes[activeTab]}
                        </div>
                    </div>
                </section>
            </div>
        </main>
    );
}

function SettingsPane({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
    return <div className={fill ? "settings-pane h-full" : "settings-pane"}>{children}</div>;
}

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || Number(defaultConfig.canvasImageCount)))));
}
