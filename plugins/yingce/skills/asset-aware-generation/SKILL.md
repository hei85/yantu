---
name: asset-aware-generation
description: 基于衍图画布已有角色、场景、道具、风格和媒体资源创建生成流程；适用于生图、视频、音频或分镜资产工作。
---

# 按镜头使用资产

先读 [画布制作规则](../yingce-film-production/references/canvas-production-rules.md)，采用用户于 2026-10-02 重新确定的顺序和引用方法。

通过 MCP 读取已有图片和真实分镜需求，复用已通过的素材。生图所需参考直接从图片连入目标图片。所有所需图片生成并检查合格后，再逐镜设置实际关联；用稳定节点 ID 写 assetBindings，按本镜需求同步 characters、requiredAssetRoles 和智能 `@` 引用。

每镜只选实际需要的角色、场景和道具。第一镜需要人物与场景，就绑定这两类；第二镜只需要人物，就只绑定人物。场景或角色版本变更时更新对应行，并清除该行无关引用。视频由对应分镜行提供提示词、采用资产和首帧，回读实际输入确认完整。

## 固定空间的参考来源

封闭室内的固定房间或相连室内空间先读 [房型、共用模型与机位](../yingce-film-production/references/fixed-space-workflow.md)。先复用房型和模型源，再从同一模型导出对应机位，检查后作为结构参考。场景外观图、模型取景图、人物身份及前镜状态分别注明用途；不把相反机位整幅复制，不以二维参考图或普通 @ 引用声称精确三维约束。已有采用图片不因补规则重生。

户外按环境与人物参考直接拆镜，不强制房型图或模型。跨镜测量锚点和道具状态按 [距离连续性](../yingce-film-production/references/spatial-distance-continuity.md) 登记；只有实际走位/搬动才改变间距。
