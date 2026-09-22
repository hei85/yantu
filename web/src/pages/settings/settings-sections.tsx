import { BarChart3, Boxes, Bug, Cloud, Gauge, KeyRound, MessageSquareText, Paintbrush, Palette, RadioTower, ScrollText, ServerCog, ShieldAlert, SlidersHorizontal, ToggleLeft, Workflow, Zap } from "lucide-react";
import type { ReactNode } from "react";

export type ConfigSectionKey =
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
    | "third-party"
    | "appearance"
    | "storage"
    | "interception"
    | "runtime-policy"
    | "system-update"
    | "runninghub"
    | "analytics"
    | "logs";

export type ConfigSection = { key: ConfigSectionKey; label: string; description: string; icon: ReactNode; group: "创作设置" | "系统"; };

export const configSections: ConfigSection[] = [
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
    { key: "appearance", label: "外观与品牌", description: "站点名称、Logo 与登录页", icon: <Palette className="size-4" />, group: "系统" },
    { key: "storage", label: "对象存储", description: "OSS / S3 与上传校验", icon: <Cloud className="size-4" />, group: "系统" },
    { key: "interception", label: "响应拦截", description: "替换上游错误文案", icon: <ShieldAlert className="size-4" />, group: "系统" },
    { key: "runtime-policy", label: "运行策略", description: "并发、超时与资源上限", icon: <Gauge className="size-4" />, group: "系统" },
    { key: "system-update", label: "系统更新", description: "版本检查与回滚", icon: <ServerCog className="size-4" />, group: "系统" },
    { key: "runninghub", label: "RunningHub 工作流", description: "工作流参数与字段映射", icon: <Workflow className="size-4" />, group: "系统" },
    { key: "analytics", label: "用量分析", description: "任务、模型与失败统计", icon: <BarChart3 className="size-4" />, group: "系统" },
    { key: "logs", label: "请求日志", description: "上游请求与响应明细", icon: <ScrollText className="size-4" />, group: "系统" },
];

export function isConfigSection(value: string | null): value is ConfigSectionKey {
    return configSections.some((section) => section.key === value);
}
