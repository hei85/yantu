# 衍图 MCP 与 Codex 插件

本目录包含插件清单、图标、MCP 启动器、画布操作与制作技能。
GitHub 源码版先按根目录 README 安装依赖并启动软件，再注册插件。
完整源码中不包含维护者的用户配置或生成媒体。

## Codex

在软件根目录运行 `安装到Codex.cmd`。脚本注册本地 marketplace、
插件与运行时指针；源码版使用系统 Node.js，便携包可用随包 Node。
安装会切换本机同名衍图插件的来源，应在希望使用的那份软件中执行。
更新后重新连接 MCP / 开新对话，让工具与技能重新加载。

## 其他 MCP 客户端

支持 stdio MCP 的客户端可用系统 Node 启动绝对路径
`plugins/yingce/scripts/start-mcp.mjs mcp`，显式设置
`CANVAS_PROJECT_ROOT` 指向本软件根目录。
启动器优先显式目录，再使用源码旁的 Runtime，缓存插件才读取安装指针。
始终校验插件版本、编译入口和配置目录，不猜测维护者的机器路径。

不同客户端的 Codex 插件清单不通用；请按该客户端的 MCP 注册方式
配置，并加载本包技能。该连接方式不代表已在每款桌面客户端实测。

## 启动与读取

软件根目录运行 `启动衍图.cmd` 或 `scripts/start-axon.ps1`。

- 网页：`http://localhost:3000`
- 后端：`http://127.0.0.1:8080`
- Runtime：`http://127.0.0.1:17371`

先调用 `runtime_diagnostics`、`canvas_list_open_canvases`，选择真实
画布后读取 `canvas_get_context`。写入使用最新 revision / stateHash，
修改串行执行，写后回读；摘要不能替代完整节点提示词。

## 功能入口

| 功能 | 入口 |
| --- | --- |
| 节点、分镜、引用与布局 | canvas-context、canvas-editing 技能及原生节点操作 |
| 图片编辑 | canvas_preflight_image_edit、canvas_edit_image、canvas_analyze_image |
| 裁剪、切图、标注、透明图层 | canvas_crop_image、canvas_split_image、canvas_annotate_image、canvas_decompose_image |
| 全景与面板操作 | canvas_create_panorama_viewer、canvas_image_node_action |
| 技能加载 | skill_catalog、skill_search、skill_read、skill_prepare |
| 模型与制作 | film_list_models、film_validate_strategy、film_create_run、film_submit_step、film_get_tasks |
| 质量、合成与交付 | film_probe_media、film_check_shot、film_record_step_result、film_render_timeline、film_verify_delivery |

GUI 与 MCP 使用实际任务和资源。AI 结果、透明度、像素、空间、对白和
连续性必须检查；工具可调用不等于所有模型都支持，也不等于结果合格。
图片编辑规则见
[工具对应与限制](skills/canvas-editing/references/image-toolbar-tools.md)。

## 规则与恢复

按任务读取 `canvas-context`、`canvas-editing`、
`asset-aware-generation` 或 `yingce-film-production`。
封闭空间先房型、再共用模型与固定机位，随后制作关键状态与视频；
四宫格拆成独立切图，前镜末态承接不能复制成新镜首格。
MCP 初始化携带简短约定，详细规则仍须按任务读取。

超时或断连先查询原 taskId / operationId，不自动重复付费；旧任务
不能覆盖新的采用资源。生成返回成功和画布回挂也不能冒充质量验收。
日志位于源码根目录 `.local/runtime/`，不要公开其中的私人信息。

## 来源

自有新增适配按根目录 LICENSE；既有 MIT 和第三方技能保留原许可。
MiniMax H3 官方指南由根目录安装脚本从固定提交下载并校验。
详见根目录 THIRD_PARTY_NOTICES.md。
