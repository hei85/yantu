# 专用画布编辑

## 绘图

绘图节点内部内容先用 `canvas_get_drawing` 读取真实快照与绘图 revision。Excalidraw 通过 `canvas_update_drawing` 使用 elementId；tldraw 通过 `canvas_update_tldraw_drawing` 使用 shapeId。两者均须携带 expectedDrawingRevision，以及 `canvas_get_context` 的 expectedCanvasId/revision/stateHash，再回读确认。tldraw 编辑受其许可证限制。写入会使旧预览和生成渲染失效。

## 导演与真实 CAM

仅封闭室内的固定房间按 [房型 → 共用模型与机位 → 生成](../../yingce-film-production/references/fixed-space-workflow.md) 执行；先查询实际导演场景，没有 sceneId 时如实记录。已存在参数化模型可复用，真实 CAM 图从同一场景取得，不能只改节点 metadata 当作几何建模。户外不强制房型与模型；跨镜距离按 [同一锚点与状态](../../yingce-film-production/references/spatial-distance-continuity.md) 核对。

导演场景使用 `canvas_get_director_scene` 读取真实 sceneHash 后，才能通过导演对象、摄影机、灯光和关键帧专用工具操作，并使用 `canvas_update_director_scene` 或 `canvas_update_director_shot` 修改已开放参数。场景变化造成版本冲突时，重新读取场景，再决定是否重做修改。打开导演工作台后可用 `canvas_capture_director_frame` 取得真实 CAM 静帧；`canvas_capture_director_video` 用活动镜头的 CAM 实时录制 0.5–30 秒 WebM。录制前读取最新画布 revision/stateHash 和场景 sceneHash，录制期间保持网页前台渲染。写后确认视频节点、Resource 和时长均已持久化，再用 `film_probe_media(fullDecode=true)` 验证实测时长与首、中、尾帧；需要成片时再用时间线导出 MP4。

## 时间线

时间线修改前读取当前时间线和轨道状态，使用 `canvas_apply_timeline_operation` 编辑片段、字幕、图文 overlay、轨道及音频混音属性。文字/图片片段的可选 overlay 使用 0 到 1 的 x/y/width/height；用 `clip.setOverlay` 修改，`null` 重置默认。`canvas_render_timeline` 按可见和静音状态渲染独立音频，并把可见字幕、文字、图片按时段叠加进视频；保存节点与 Resource 后回读、探测并检查实际帧。图片只接受 PNG/JPEG/WebP，其他格式或解码失败会明确报错。
