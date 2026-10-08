# 图片工具与 MCP 对应关系

按当前 `canvas_get_capabilities` 的实际工具清单调用。首次读取完整画布并确定图片 nodeId；写入带新鲜 expectedCanvasId、expectedRevision、expectedStateHash。旧网页未重载或旧客户端未重新发现工具时，不把修改 metadata 当作专用功能已执行。

## 工具选择

| 界面功能 | 原生 MCP 调用 | 输入与限制 |
| --- | --- | --- |
| 局部重绘 | `canvas_preflight_image_edit` → `canvas_edit_image(action="mask")` | 修改说明及归一化 regions 或同像素尺寸 PNG 蒙版；透明区域可编辑，其他区域受保护；需要真实蒙版能力 |
| 文字编辑 | `canvas_analyze_image(analysis="text_detection")`，按识别内容 `canvas_edit_image(action="text")` | lines 中写原文、位置、新文字；识别需要能看图的文字模型 |
| 表情调整 | `canvas_edit_image(action="emotion")` | 原图内的人脸矩形 face、人物名称与 -2…2 的 intimacy/arousal；真实裁切输入、身份参考及本地羽化合成 |
| 质感调整 | `canvas_edit_image(action="texture")` | texture 的肤质、人景融合、光影融合、纹理、锐度；按当前 schema 枚举填写 |
| 多角度 | `canvas_edit_image(action="angle")` | angle 的水平角、俯仰角、距离与 wideAngle；图片生成机位参数不能证明世界尺度已校准 |
| 打光 | `canvas_edit_image(action="lighting")` | lighting 的方向、亮度、颜色、轮廓光；保持人物、构图和物体位置 |
| 标注 | `canvas_annotate_image` | marks 支持矩形、椭圆、线、箭头、文字；原图 0–1 坐标，颜色与字号；本地生成新 PNG |
| 标注编辑 | `canvas_edit_image(action="annotation_edit")` | 修改说明与 marks；生成实际标注图作为第二输入，绑定真实图片节点及内联引用 |
| 去除背景 | `canvas_edit_image(action="remove_background")` | 模型须支持真实透明输出；回填检查 alpha。需要本地算法时先检查 `canvas_convert_media` 的 cutout 能力与运行依赖 |
| AI 图层拆分 | `canvas_decompose_image` | 2–6 个 layers，每个有名称、提取说明及可选区域；各层独立任务、独立计费及幂等 ID；输出核对 alpha 与同画幅 |
| 全景图 | `canvas_create_panorama_viewer`，随后 `canvas_set_panorama_view` / `canvas_capture_panorama_view` | 投影已有图片的球面/柱面查看节点；不会自动重建照片外的 360 度空间。生成全景素材另走真实图片生成并验收 |
| 裁剪 / 宫格切分 / 调整尺寸 | `canvas_crop_image` / `canvas_split_image` / `canvas_upscale_image` | 本地处理并持久化 Resource/Asset；调整尺寸是插值，不能叫 AI 超分 |
| 信息 / 生成设置 / 预览 / 复制 / 下载 | `canvas_get_node`，需要界面操作时 `canvas_image_node_action` | 读完整节点获得信息/提示词；设置变更用 `canvas_update_node` 的真实字段。下载只确认浏览器请求已触发，磁盘保存另核对 |
| 宽高比锁定 / 位置尺寸锁定 | `canvas_resize_node(freeResize=…)` / `canvas_toggle_node_locked` | 不解锁用户内容来完成无关整理 |
| 保存素材 / 替换图片 / 删除 | `canvas_save_node_asset` / `canvas_replace_node_media` 或 `canvas_upload_file(nodeId=…)` / `canvas_delete_nodes` | 使用真实资源；删除先核对分镜与时间线采用关系 |

## 图片编辑的提交与验收

从 `film_self_check` 取得实际待检查资源，用 `canvas_read_quality_reports` 读取可复用的原生审美/肖像报告，再按发现的问题选择本表工具。报告过期、没有逐项观察或缺少声音/连续性检查时不能放行；深度、姿态和透明通道只在各自范围内提供证据。详见 [自检闭环](self-check-workflow.md)。

1. 先用预检核对具体操作的区域、参数、参考数量及模型能力。ready 只表示本地合同与配置可行，不能宣称上游已验证。
2. 修改说明放在真实输出节点的提示词中，内联引用绑定真实输入。蒙版、标注图和表情裁切作为实际输入；同一人的身份参考不能变成第二个人。
3. 收费调用提供稳定 clientOperationId；短提交返回真实 taskId。先查原任务，通信超时不视作终止失败，不换 ID 重发。明确失败重试使用新 ID 与实际 retryOf；图层重试按具体层处理。
4. 原生任务生命周期负责回填、重载恢复与入库；结果只到“可读取”仍需逐张审看。去背景/图层读 `metadata.imageTool.checks`，没有 alpha、空主体或错误画幅会记 failed；存在 alpha 也只验证了透明通道，不证明提取内容或边缘合格。
5. 新结果保留源图和采用版本、真实关联与独立节点，局部排开并归入可修改的原有框。空间连续性继续依据房型、共用模型与固定机位；修图不能悄悄修改房间结构或消失的道具。

## 其他 Agent 从剧本开始

MCP 客户端需能发现并调用本包工具，软件及画布运行正常，已配置所需文字/图片/视频渠道，并有当前任务的费用授权。通过 skill_catalog / skill_prepare 读取真实版本的整片制作技能；若客户端支持 Codex 插件，也可加载本包技能文件。技能选择、阶段证据、任务轮询和媒体验收仍需要 Agent 执行，MCP 自身不是“给剧本就必定成功”的创作模型。

封闭空间执行房型图 → 共用模型及机位 → 关键帧与视频；户外不强制房型。已有采用图片优先复用。首尾帧使用独立切图，过渡参考推进动作、不照抄前镜末格；按模型能力引用，过渡实际进入时间线。用户只要求查看或修改工具时，不重新制作整片。
