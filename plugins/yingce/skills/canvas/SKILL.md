---
name: canvas
description: 使用本便携版衍图 MCP 控制画布、分镜、媒体节点和生成流程；需要实际操作衍图时使用，按任务加载上下文、编辑或制作技能。
metadata:
  version: "1.1.3"
---

# 便携版画布入口

本插件 MCP 通过安装脚本登记的运行时指针使用对应便携包。先用 `runtime_diagnostics`、`canvas_list_open_canvases` 确定真实连接和目标，不能按缓存插件目录、旧标签页或同名服务猜路径。

- 查看、定位或刷新写入版本：读 [canvas-context](../canvas-context/SKILL.md)，首次完整读取，后续简要读取并针对目标查详情。
- 创建、引用、布局或清理：读 [canvas-editing](../canvas-editing/SKILL.md)，明确目标、使用最新前置条件、写后回读。默认局部布局，保护采用版本。
- 图片工具栏的局部重绘、文字、人像、视角、标注、图层与全景：读 [图片工具与 MCP](../canvas-editing/references/image-toolbar-tools.md)，使用对应原生工具，区分本地处理、AI 收费任务和实际质量验收。
- 生图/视频需要已有素材：读 [asset-aware-generation](../asset-aware-generation/SKILL.md)，核对真实输入、去重与内联引用。
- 用户要求制作、接续或修复整片：读 [yingce-film-production](../yingce-film-production/SKILL.md) 和 [画布制作规则](../yingce-film-production/references/canvas-production-rules.md)。已有验收素材复用；按镜头和过渡顺序组织，图片验收后绑定视频输入。普通查看、移动或引用编辑无需重新执行整片准备。
- 封闭室内的一致性与机位规划：读 [固定空间三步流程](../yingce-film-production/references/fixed-space-workflow.md)。先房型，再共用模型与机位取景，最后关键帧和视频；仅查看或修改引用时复用已检查阶段。户外不强制房型与建模。距离漂移读 [距离连续性](../yingce-film-production/references/spatial-distance-continuity.md)，从剧本自动接管读 [工作流与经验](../yingce-film-production/references/script-to-film-automation.md)。

- 连接中断或启动软件：读 [open-canvas](../open-canvas/SKILL.md)，恢复正确包与原任务。

批量创作表先用 `canvas_batch_table_read`，通过表格工具维护行/列/引用；提交前 `canvas_preflight_batch_rows`。分镜先读稳定 rowId，用原生逐行工具建立输出，提交前 `canvas_preflight_storyboard_media`。创建输出节点与预检均不代表生成已经提交。

转换节点使用 `canvas_convert_media` 的真实本地算法，不只改状态字段。绘图、导演摄影机/场景、时间线用专用编辑工具及独立版本，按编辑技能中的对应参考执行。

按当前用户授权执行，优先原生 MCP；所有成功与质量结论都必须有实际工具结果和媒体证据，缺失能力明确报告。模型特定提示词按真实模型选择：确认 MiniMax H3 才加载官方 H3 和中文适配技能。
