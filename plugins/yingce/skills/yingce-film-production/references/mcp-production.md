# MCP 制作与恢复

以下是当前衍图工具的调用关系，不代替运行时 schema。发现工具后读取实际参数，再调用；工具集可能更新。

## MCP 控制规则

1. **先确认目标再写。** 调用真实 `runtime_diagnostics` 和 `canvas_get_context`，核对当前便携版、canvasId、业务 projectId、节点及连线。不能把旧目录、其他画布或业务项目 ID 混作当前目标。仅制定规则或分析问题时只做所需读取，不追加创作节点、不生成媒体。
2. **按任务发现工具。** 用当前工具目录/schema 选择读取、建资产、编辑分镜、生成、检查或导出能力；真正调用 MCP。文本计划不是一次工具调用；工具返回成功也不是内容验收。普通单节点试验使用 canvas 工具，整片按持久制作计划执行。
3. **先查能力再选模型与参数。** 用 `film_list_models`、`film_validate_strategy` 读取并核验本渠道的操作、参考数量、首尾帧、音频、画幅、分辨率和时长。用户指定系列时只在该系列内选型号。未知能力不猜，不按型号后缀推断；没有支持的参数就不传。
4. **读真实资产，写精确引用。** 人物、场景、道具、声音、首帧和尾帧采用稳定节点/资源/版本 ID，明确用途。已经存在且通过检查的素材复用；一张参考图请求 count=1。参考素材按已接通的上游传输方式发送，个人中转站只做计费转发，不额外存储素材。不要重复搭节点、把占位图当成素材或用上一场的人物版本覆盖用户当前版本。
5. **每次写入带状态检查。** 画布修改先取最新 expectedCanvasId/revision/stateHash；时间线还带 expectedHash。冲突后重读并调整本次变更，不覆盖用户新操作。删除、替换或重做应有当前任务依据，先保留可复用产物及任务记录。
6. **提交与恢复分开。** 付费整片步骤用 `film_submit_step`、当前能力版本和稳定幂等键。独立镜头按依赖并发，遵守当前运行的并发限制；共享状态、首尾帧继承和同画布写入顺序执行。超时按原 taskId 与 nextPollAt 查询，不重复提交。
7. **真实结果回挂后再验收。** `film_get_tasks` 读取实际状态/资源；按本工具支持的注册/恢复路径挂回指定资产、分镜与视频节点。确认同用户、同画布、同 run/row/segment，不能仅凭某个资源 URL 给任意节点写“成功”。检查媒体格式与内容，将 passed/failed/uncertain 写回运行。
8. **每批整理，全片交付。** 每批创建及最终交付后检查画布，整理受影响容器和区域，用分区与均衡网格，回读检查无重叠、无丢节点/连线；用户要求整体整理时再重排整画布。时间线以目标帧数控制；真实导出及完整质量核验通过才交付。需要用户补信息时说明具体缺项，既有授权无需再问。

## 制作阶段与工具对应

| 制作阶段 | MCP 实际动作 | 留下的依据 |
| --- | --- | --- |
| 接收、拆解、设计、粗分镜 | 读取项目；按需 `skill_search`/`skill_prepare`/`skill_read`；用当前文本操作和项目/分镜工具登记产物 | 剧本版本、场景/角色/资产清单、连续性、粗分镜 |
| 人物/场景/道具资产 | 查现有项目/画布资源；缺项才建图像流程并调用真实生成工具；登记任务输出到资产版本 | resource/asset/version ID、用途及实际检查 |
| 声音方案 | 查实际声音能力和项目声音版本；需要的配音才按工具支持路径准备，默认原声模式保持 | 准确台词、人物声音绑定、实际音频长度 |
| 锁镜、分镜粗剪 | 更新真实 Script 行及业务镜头；读取/编辑时间线，计算采用区间 | row/shot/segment ID、资产绑定、锁定总帧数 |
| 样片与逐镜制作 | 建立/接续 ProductionRun；验证策略、提交依赖就绪步骤、回查原任务、回挂真实结果 | 模型能力版本、原始输入、attempt/task/resource、检查结果 |
| 后期与交付 | 编辑时间线；probe、render、verify；检查画布并整理受影响区域 | 可播放成片、精确时长及格式/内容验收、可编辑工程 |

逐阶段细节见 [正式制作流程](formal-production-workflow.md)。表中没有给出的工具名必须从当前目录发现，不臆造上传、口型或音色工具。

## 上下文、技能与能力

1. `runtime_diagnostics` 确认连接；`canvas_get_context` 读取当前 canvasId、revision、stateHash；`project_get_context` 读取业务项目。不得把浏览器画布 ID 猜作业务项目 ID。
2. `film_list_operations` 获取真实分镜/资产/提示词操作名。需要模板推理时使用 `film_run_operation`，它只执行文本操作。
3. `skill_search` / `skill_catalog` 查当前用户有效技能；由 AI 按任务挑选实际 skillId，再传 selectedSkillIds 给 `skill_prepare`。大型路由包按需用 `skill_read(path)` 读取相应子技能；不要因阶段相同就加载整个目录。分页读到 complete，保留 skillId、versionId、contentHash 以便写回技能应用证据。不要把摘要或搜索命中当成已读完整技能。
4. `film_list_models` 读取当前模型目录；用 `film_validate_strategy` 对实际输入、画幅、清晰度、时长、音频和首尾帧需求做只读校验。模型标注和单次 ASR 命中是选型证据，不能证明稳定音质。

全局安装的技能可直接从 Codex 技能目录读取；软件技能库中的版本通过 MCP 读取。一次制作锁定所用版本，接续时核对变化，避免自动更新在制作中途改变结果。

## 计划与任务

自检与审计调用 `film_self_check`；现有审美/肖像报告调用 `canvas_read_quality_reports`。按 [逐资源自检闭环](self-check-workflow.md) 补足实际观察，记录通过/失败/未验证。新建整片默认 selfCheckVersion=1，由构建器生成实际资源与输出步骤的覆盖合同，旧运行不自动改版或重生素材。

整片按 [正式制作流程](formal-production-workflow.md) 保存前期产物引用与检查结果。所需资产、声音方案和锁定分镜未通过时不能批量提交视频，不能用纯文本“已完成”作为空证据。

- 分镜业务数据用 `project_create_or_update_shots`；资产链接、版本和生成结果使用实际 `project_*` 工具。画布节点与业务镜头都要可回读。
- `film_create_run` 保存 brief、目标时长/帧率、模型约束、生成策略、步骤依赖和交付合同。`clientKey` 对同一个制作请求保持稳定；从返回值取得 runId、stepId 和 revision。
- 若工具未加载，先发现当前插件的真实工具与 schema；不能仅凭本文件调用同名假工具。模型锁定使用目录返回的完整渠道模型 ID，系列约束也要逐个核对候选模型。
- 默认 `audioMode=NATIVE_AUDIO`。只有用户明确要求去掉原声重配才用 `REBUILD_AUDIO`，不能以旧的 audioPolicy 字段代替选择。
- 需要的收费计划授权采用当前服务支持的正常界面/接口，保留用户已有授权；不要用假费用或本地修改状态绕过服务校验。未知价格先核实渠道实际价目/可信预估；只有运行已持久保存 `authorizationStatus=authorized` 和 `budgetPolicy=unbounded` 时，可用 0 表示未知预估，0 不代表免费。有限预算须使用真实正数预估。
- 整片付费生成走 `film_submit_step`，提交当前 expectedRevision、模型 capabilityRevision、真实费用预估和稳定 idempotencyKey。锁定用户指定模型/系列；不能因不兼容偷偷改用其他系列。
- 同一 attempt 的网络重试使用相同幂等键；有明确失败且决定重新生成时，建立新 attempt 并记录 retryOf。改变参考、提示词或规格是新的输入，不复用旧成功任务冒充新结果。
- `film_get_tasks` / `film_wait_task` 查询已提交任务，按 nextPollAt 等待。超时不代表失败，也不触发新收费任务。
- `project_register_task_output` 将真实 taskId/resourceId 绑定至资产/步骤；`film_record_step_result` 写入检查和语义证据。语义未检查时填写 uncertain。

### 新建整片的阶段记录

当前整片入口使用 `plan.productionSpec.workflowVersion=2`。`productionSpec.version` 仍为 1，不要把这两个字段混用。Brief、创建请求、productionSpec 和交付合同中的目标时长、画幅与帧率保持一致。由当前计划构建器生成 `executionManifest.workflowVersion=2` 与 `stageContracts`；从返回的计划读阶段指纹和步骤 ID，不手写一组绕过依赖的步骤。

`preproduction` 包含 sourceScript、brief、scriptBreakdown、visualDesign、roughStoryboard、assetPackage、soundPlan、lockedStoryboard、pilot。每项引用有 `artifactId`、`versionId`、`inputFingerprint`、`outputFingerprint`，对应实际保存的文档或清单及内容版本。资产包与样片的前置引用是需求清单和试制计划；不能把它们当作尚未生成的媒体或已通过的报告。

粗分镜和锁定分镜带有序 `rowIds`；资产包带 `assetIds`；声音方案带真实 `voiceVersionIds`，没有此类绑定时为空数组；锁定分镜带准确 `durationFrames`；样片计划带按项目风险选择的 `sampleRowIds`。这些集合必须与当前分镜、资产、声线版本及目标帧数一致。

完成阶段后，用 `film_record_step_result` 记录 `evidence.checks`、`evidence.semanticQuality` 和 `evidence.stageEvidence`。`stageEvidence` 提供 `workflowVersion:2`、实际 `stageKey`、当前 `inputFingerprint`、`artifacts`、`inputArtifacts` 及该阶段合同中的行/资产/声线/帧数字段。引用从持久计划读取；内容检查注明评估者与意见，未检查记 uncertain，不能只有“已完成”三个字。

资产阶段另外提供 `assetOutputs`，逐项对应真实 asset/version/resource；样片阶段提供 `mediaArtifacts`，对应成功镜头的 row/segment/resource。后期阶段核对真实时间线母版。所需资产、声音和锁镜检查通过后才能试制；代表性样片及其画面/声音检查通过后才能批量视频。接续已有运行先读其流程版本，不为了换规则重发已经成功的任务。

## 画布与时间线

制作顺序和引用方法先读 [画布制作规则](canvas-production-rules.md)：图片直接引用所需已有图片；全部所需图片验收完成后，按每镜实际需求关联资产；视频仅从对应分镜行继承提示词、素材和首帧。

- 单次素材试验可用 `canvas_create_generation_flow` / `canvas_generate_*`；需要首尾帧时分别指定 start/end 节点，不依赖引用列表的偶然顺序。
- 写画布前读取新上下文，提供 expectedCanvasId、expectedRevision、expectedStateHash；冲突后重读并按新状态调整。不得盲目覆盖用户改动。
- 每批创建完成后、生成导致节点尺寸变化后及交付前，读取新上下文整理整张画布。从左到右保持图像区、分镜区、视频区，文档另区；各区只放对应节点，按真实尺寸用 `canvas_layout_nodes` 的局部网格或明确位置对齐留白。保留锁定节点及容器，避免通用自动布局打散用户要求的顺序和分区。回读核对节点、素材与必要连线仍在，节点没有重叠，视频逐个可见。
- `canvas_get_timeline` 回读时间线；`canvas_apply_timeline_operation` 除画布状态还要求 expectedHash。时间线单位从 schema 确认，生成时长和采用时长分开。
- `film_render_timeline` 导出整片，使用真实项目 ID、runId/stepId、已接受资源与当前 executionManifest。`film_probe_media(fullDecode=true)` 检查素材；`film_verify_delivery` 检查最终资源与时长、画幅、音轨和字幕合同。
- 根据整理结果用 `canvas_set_viewport` 定位完整分区概览，交付可见节点、播放入口、成片与可编辑时间线。

## 恢复

保留 projectId、canvasId、runId、最后事件序号、任务/产物 ID、已采用资源和未通过的检查。用 `film_get_run(afterSequence)` 读取权威进度，继续未完成依赖；未结清任务先查状态。计划变更使用 `film_update_plan` 并核对返工影响，保留旧 attempt。
