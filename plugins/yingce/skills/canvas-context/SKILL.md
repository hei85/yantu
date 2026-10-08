---
name: canvas-context
description: 读取衍图画布的真实节点、选区、连线、资源和任务状态；基于现有画布定位对象或刷新编辑前置条件时使用，本技能不提交生成。
metadata:
  version: "1.1.0"
---

# 读取画布事实

首次调用 `runtime_diagnostics`、`canvas_list_open_canvases`，按用户当前目标确定 `canvasId`。同一画布多标签读取还需 `clientId`；写入遇到 `same_canvas_multiple_clients` 先解除重复标签，不能把只读选择器当成写入授权。不要用标题相同来判断同一项目，区分画布 ID 和短剧项目 ID。

首次用 `canvas_get_context(detail="full")` 理解布局、选区、节点类型和关系。后续仅刷新前置条件时用 `detail="summary"`，保留 `canvas.projectId`、`revision`、`stateHash`。summary 的省略数量不表示内容不存在；最多返回20个选区摘要，不能当作完整选区。旧工具 schema 尚无 detail 参数时先使用它支持的读取方式，重新连接 MCP 后再使用新模式。

按缺少的信息读取，避免每一步重传全图：

| 需要的信息 | 工具与核对点 |
| --- | --- |
| 精确目标、已知 ID | `canvas_find_nodes` / `canvas_get_node`；检查 found 和真实类型 |
| 修改长提示词或文本 | `canvas_get_node.node.metadata` 中完整 content、prompt、composerContent；概要预览会截断 |
| 连线及输入来源 | `canvas_get_connection`；核对 from/to、分镜行及手动连接 |
| 分镜资产与输出 | `canvas_get_storyboard`；使用稳定 rowId，区分采用素材与历史输出 |
| 当前画布任务 | `canvas_get_generation_tasks`；这是页面快照，不是上游主动轮询 |
| 原任务实际进度 | `film_get_tasks` / `film_wait_task`；使用已提交 taskId，尊重 nextPollAt |
| 可复用素材 | `canvas_get_resources` / `canvas_find_available_assets`；核对真实 resourceId、版本和就绪状态 |

节点有缩略图、任务返回成功、资源可解码与质量合格是不同证据。正常镜头裁切不算人体缺失；空间、手脚、道具、声音等质量判断按制作规则和实际媒体检查。用户已经采用的图片先复用。

MCP 错误先看 `error.code`、`operationOutcome`、`nextAction`。`runtime_unreachable` 说明本地控制服务连接失败；通信中断、工具超时和回执不完整不能证明上游失败。恢复后查原任务和资源。不得为恢复连接复制画布、换 ID 重提生成或覆盖用户修改。
