# 图片工具与 MCP 入口

本表描述源码中的功能入口与必要检查，不代表已在所有渠道逐项实测。
先通过 runtime_diagnostics、canvas_get_capabilities 发现当前实例能力。

| 功能 | MCP 入口 |
| --- | --- |
| 局部重绘、文字、人像、角度与打光 | canvas_preflight_image_edit → canvas_edit_image |
| 图像理解、文字检测与反推提示词 | canvas_analyze_image |
| 全景 | canvas_create_panorama_viewer、set/capture_panorama_view |
| 裁剪与尺寸插值 | canvas_crop_image、canvas_upscale_image |
| 标注与标注编辑 | canvas_annotate_image、canvas_edit_image(annotation_edit) |
| 宫格独立切图 | canvas_split_image |
| 透明背景 | canvas_edit_image(remove_background) |
| 独立透明图层 | canvas_decompose_image |
| 预览、下载、节点信息与生成面板 | canvas_image_node_action、canvas_get_node |
| 锁定宽高比与位置尺寸 | canvas_resize_node、canvas_toggle_node_locked |
| 保存、替换及删除 | canvas_save_node_asset、canvas_replace_node_media、canvas_delete_nodes |

图片编辑生成新结果并保留原图。蒙版、输入、绑定与真实请求一致；
AI 图层各有独立任务和结果，不能把单张合并图叫作拆分。透明度、
像素和画幅用实际资源检查，内容仍须审看。

真实本地操作可按像素验证，AI 操作还要有用户授权、可用模型、真实
taskId、返回资源和质量检查。没有运行证据不能把入口存在写成通过。
超时先查原任务，稳定操作 ID 与 retryOf 用于安全恢复。

Codex 使用本仓库安装脚本，其他客户端按 stdio MCP 注册并加载技能。
源码发行需先构建；完整步骤和许可见根目录 README。
