import { Boxes, Bug, KeyRound, MessageSquareText, Paintbrush, RadioTower, SlidersHorizontal, Zap } from "lucide-react";
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
    | "drawing-engine"
    | "third-party";

export type ConfigSection = { key: ConfigSectionKey; label: string; description: string; icon: ReactNode; group: "创作设置" | "系统"; };

export const configSections: ConfigSection[] = [
    { key: "quick", label: "模型设置", description: "添加模型、查看接入并设置创作默认", icon: <Boxes className="size-4" />, group: "创作设置" },
    { key: "channels", label: "模型接入", description: "高级渠道与已接入模型", icon: <RadioTower className="size-4" />, group: "创作设置" },
    { key: "models", label: "模型选择", description: "按用途设置创作默认", icon: <Zap className="size-4" />, group: "创作设置" },
    { key: "preferences", label: "生成偏好", description: "画布生成默认值", icon: <SlidersHorizontal className="size-4" />, group: "创作设置" },
    { key: "prompts", label: "提示词偏好", description: "按任务定制平台模板", icon: <MessageSquareText className="size-4" />, group: "创作设置" },
    { key: "diagnostics", label: "问题诊断", description: "导出日志协助排查", icon: <Bug className="size-4" />, group: "创作设置" },
    { key: "prompt-templates", label: "提示词模板", description: "平台创作策略版本", icon: <MessageSquareText className="size-4" />, group: "系统" },
    { key: "drawing-engine", label: "绘图工具", description: "画布绘图节点默认引擎", icon: <Paintbrush className="size-4" />, group: "系统" },
    { key: "third-party", label: "第三方参数配置", description: "第三方凭据与集成参数", icon: <KeyRound className="size-4" />, group: "系统" },
];

export function isConfigSection(value: string | null): value is ConfigSectionKey {
    return configSections.some((section) => section.key === value);
}
