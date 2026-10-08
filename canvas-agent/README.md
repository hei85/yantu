# 衍图 Canvas Agent

本地 Canvas Agent 用来连接画布网页和外部 Codex 的衍图插件 / yingce MCP。它只提供本机 Runtime 和 stdio MCP，不启动第二套 Codex 或 Claude 推理宿主。本地开发时优先连接 `http://localhost:3000`。

## 启动

当前仓库统一使用本地构建产物启动。依赖锁定在 `bun.lock`，不要用 pnpm 或 npm 覆盖同一套 `node_modules`：

```bash
cd canvas-agent
bun install
bun run build
node dist/index.js
```

启动后会输出本机地址和 token：

```txt
Local URL: http://127.0.0.1:17371
Connect token: xxxxxx
```

在画布右上角点击 `Agent`，填入地址和 token 后连接。

## ComfyUI Bridge

Bridge 让云端后端把工作流请求投递到运行 Bridge 的机器，再由该进程访问 ComfyUI。`--comfy` 可填写本机 `127.0.0.1:8188`、局域网地址或公网 HTTP/HTTPS 地址，只要运行 Bridge 的机器能够访问即可；网页和云端不直接访问该地址。

部署镜像会用 Go 标准库把 Bridge 交叉编译成站点根目录下的 Windows x64、Linux x64 和 Linux ARM64 原生程序。它们不捆绑 Node.js/Bun 运行时，运行 Bridge 的机器不需要安装 Node.js、npm 或项目源码；画布“设置 → ComfyUI Bridge”会按平台生成带当前地址、令牌和工作流目录的完整命令。

```powershell
$bridgeDir = Join-Path $env:LOCALAPPDATA "OpenAICanvas"
New-Item -ItemType Directory -Force -Path $bridgeDir | Out-Null
$bridgeFile = Join-Path $bridgeDir "OpenAICanvas-ComfyBridge.exe"
Invoke-WebRequest "https://你的画布服务地址/OpenAICanvas-ComfyBridge.exe" -OutFile $bridgeFile
$bridgeStream = [System.IO.File]::OpenRead($bridgeFile)
try { $bridgeHeader0 = $bridgeStream.ReadByte(); $bridgeHeader1 = $bridgeStream.ReadByte() } finally { $bridgeStream.Dispose() }
if ($bridgeHeader0 -ne 0x4D -or $bridgeHeader1 -ne 0x5A) { throw "Bridge 下载失败：服务器未返回 Windows 可执行程序，请联系管理员重新部署 Bridge" }
& $bridgeFile --server "https://你的画布服务地址" --token "你的 Bridge Token" --comfy "http://127.0.0.1:8188" --workflow-dir "D:\\ComfyUI\\workflows"
```

Linux x64 云服务器（ARM64 服务器请把文件名中的 `amd64` 改为 `arm64`）：

```bash
bridge_dir="./openai-canvas-bridge"
mkdir -p "$bridge_dir"
curl --fail --location "https://你的画布服务地址/OpenAICanvas-ComfyBridge-linux-amd64" --output "$bridge_dir/OpenAICanvas-ComfyBridge-linux-amd64"
chmod +x "$bridge_dir/OpenAICanvas-ComfyBridge-linux-amd64"
"$bridge_dir/OpenAICanvas-ComfyBridge-linux-amd64" --server "https://你的画布服务地址" --token "你的 Bridge Token" --comfy "http://127.0.0.1:8188" --workflow-dir "/opt/ComfyUI/user/default/workflows"
```

如果 ComfyUI 和 Bridge 都在云端 Linux，`--comfy` 建议使用 `http://127.0.0.1:8188`，不要把 ComfyUI 的 8188 端口暴露给公网。生产环境可将上面的 Bridge 命令配置为 systemd 服务，确保云服务器重启后自动恢复；Bridge Token 应通过受限的环境文件或服务管理器注入，不要写进公开脚本。

工作流可以在“设置 → ComfyUI Bridge”中选择 Bridge 发现的 API JSON、粘贴 ComfyUI API 格式 JSON，也可以只填写 `workflowId`，让 Bridge 从 `--workflow-dir` 下读取同名 `.json` 文件。Bridge 会分析本机工作流，并把可配置字段回传给可视化映射面板；面板可设置任务提示词、固定文本、参考图片/视频/音频顺序、蒙版、尺寸、宽高、数量、质量、视频时长、音频参数、随机 Seed 以及必选/可选规则。未保存字段映射时，Bridge 也会在执行前按同一规则分析工作流；正向 Prompt 优先于负向文本节点。参考素材会先上传到本机 ComfyUI，多余素材或缺失的必选槽位会直接报错，可选媒体缺失时不会继续使用工作流模板中的旧文件名。映射同时兼容原项目配置里的 `node`、`input`、`default` 和 `bind_prompt` 字段。RunningHub 工作流在独立的“设置 → RunningHub 工作流”中管理，不属于模型渠道。

Bridge Token 只用于主动轮询和回传结果，不要提交到 Git 或写入公开日志。Bridge 执行长任务时每 30 秒发送心跳；远程参考素材只允许解析到公网地址，`127.0.0.1`、localhost、私网和链路本地地址会被拒绝。请求、领取状态和完成结果由后端持久化：后端重启后未领取请求会继续投递，已领取请求的迟到结果也能由恢复后的任务读取；Bridge 进程自身在执行中退出时，本机 ComfyUI 任务仍不能自动接管。工作流请求 JSON 上限为 16MB，结果 JSON（含 base64 媒体）上限为 64MB，超大视频建议改为资源上传链路。

Bridge 首次使用网页生成的命令启动后，会把服务器地址、Token、ComfyUI 地址和工作流目录保存到本机用户配置目录（权限为仅当前用户可读）。之后重启或断线恢复可以直接再次启动 Bridge 程序，不需要重新填写这些参数；如需更换连接目标，再使用带参数的启动命令覆盖旧配置。

Codex app 插件会读取启动输出里的 Local URL 和 Connect token，并直接打开画布网页地址；Canvas Agent 不负责生成画布打开 URL。

Canvas Agent 默认只监听 `127.0.0.1`。网页第一次带正确 token 连接后，Canvas Agent 会记录该网页 Origin；之后其他 Origin 不能复用这个本地 Agent，除非用户清理 `~/.infinite-canvas/canvas-agent.json` 里的 `origins`。

## Dreamina CLI 安全边界

- 外部程序直接切换 Dreamina CLI 账号无法被本应用实时观测；只能在下一次 CLI 状态或命令边界重新校验，因此本机任务运行期间请不要在其他程序中换号。
- 官方 CLI 的 argv 可能被同一 OS 用户通过进程列表看到，其中可能包含 prompt、receipt 或本地路径；这是官方 CLI 的进程边界，本应用不承诺对同机用户隐藏这些参数。

## 肖像可识别性本机引擎

Canvas Agent 内置 `portrait-clearance` Local Runtime 模块。它只接收签名的画布请求，不读取项目 API Key；图片、embedding、候选和报告保存在 Agent 的配置目录，不进入画布 JSON。

本机模型不会随 npm 包发布。用户必须在肖像排查工作台中显式安装并校验 `buffalo_l` 所需的 `det_10g.onnx` 与 `w600k_r50.onnx`，安装过程保留现有可用模型并拒绝校验失败的临时文件。缺少模型时，模块返回 `portrait_model_missing`，不会伪造低风险结果。

## Depth Anything V2 本机深度模块

画布“转换 → 深度图”使用 `depth-estimation` Local Runtime 模块。模块只接受签名的本机请求，Node Runtime 启动一个常驻 Python worker；模型首次调用时加载，后续转换复用同一进程。worker 以离线模式读取本地 Hugging Face 缓存，不会把图片发送到云端。

使用仓库根目录的 `start-yingce-local.cmd` 时，Canvas Agent 会和前端、后端一起自动启动，转换节点不需要用户另外打开 Agent 窗口或手工填写地址。只有手工分别启动前端和后端时，才需要在本目录执行 `node dist/index.js`。

当前仓库开发环境默认查找：

```text
.local/depth-anything-v2/venv/Scripts/python.exe   # Windows
.local/depth-anything-v2/venv/bin/python           # Linux/macOS
.local/cache/huggingface/                          # 模型缓存
```

发布包会携带 `python/depth_anything_runtime.py`，但不会携带 Python、依赖或模型权重。自定义安装位置时设置 `CANVAS_DEPTH_PYTHON`、`CANVAS_DEPTH_HF_HOME`；需要指定工作区时设置 `CANVAS_PROJECT_ROOT`。模型缺失、Python 环境缺失或 worker 退出时，转换节点显示具体失败状态并保留输入，不会把失败标记为完成。

## ControlNet Aux 本机 AI 线稿模块

画布“转换 → AI 线稿”使用 `lineart-estimation` Local Runtime 模块。它只运行 ControlNet Aux 的 `LineartDetector` 预处理器，把图片转换为线稿控制图；不会加载 Stable Diffusion、ControlNet 生图管线，也不会把图片上传到云端。Node Runtime 会复用同一个常驻 Python worker，首次转换加载模型，后续请求复用已加载模型。

该模块与深度模块共用 `.local/depth-anything-v2/venv` Python 环境和 `.local/cache/huggingface` 模型缓存。首次设置或缺少依赖时，在仓库根目录执行：

```powershell
$python = ".local/depth-anything-v2/venv/Scripts/python.exe"
& $python -m pip install -r canvas-agent/python/requirements-lineart.txt
```

然后用下面的命令把线稿预处理器权重缓存到本地；下载完成后，正常转换会强制离线运行：

```powershell
$env:HF_HOME = (Resolve-Path ".local/cache/huggingface").Path
$env:HF_HUB_CACHE = Join-Path $env:HF_HOME "hub"
& $python -c "from controlnet_aux import LineartDetector; LineartDetector.from_pretrained('lllyasviel/Annotators')"
```

自定义安装位置时设置 `CANVAS_DEPTH_PYTHON`、`CANVAS_LINEART_HF_HOME` 和 `CANVAS_LINEART_MODEL_ID`；未找到 Python、依赖或模型时，节点显示“本地不可用”并保留输入，不会伪造已完成结果。

## ControlNet Aux 本机姿态骨架模块

画布“转换 → 姿态骨架”使用 `pose-estimation` Local Runtime 模块。当前笔记本方案采用 ControlNet Aux 的 **OpenPose body-only** 预处理器：只提取人体 18 点骨架并输出彩色姿态图，不加载 Stable Diffusion，也不上传图片。Node Runtime 会复用常驻 Python worker；未检测到人物时返回 `pose_no_person`，转换节点显示“已跳过”，不会保存伪造结果。

该模块与深度、线稿共用 `.local/depth-anything-v2/venv` Python 环境和 `.local/cache/huggingface` 缓存。安装 `requirements-lineart.txt` 后缓存人体权重：

```powershell
$python = ".local/depth-anything-v2/venv/Scripts/python.exe"
$env:HF_HOME = (Resolve-Path ".local/cache/huggingface").Path
$env:HF_HUB_CACHE = Join-Path $env:HF_HOME "hub"
& $python -c "from huggingface_hub import hf_hub_download; hf_hub_download('lllyasviel/Annotators', 'body_pose_model.pth', cache_dir='$env:HF_HUB_CACHE')"
```

自定义安装位置时设置 `CANVAS_POSE_PYTHON`、`CANVAS_POSE_HF_HOME` 和 `CANVAS_POSE_MODEL_ID`。DWPose（包含手部、脸部和更完整关键点）仍可在后续按需替换，但它需要额外的 MMDetection/MMPose 依赖；当前实现优先保证普通 CPU 笔记本可运行。

## 发布

`canvas-agent` 使用自己的 `package.json` 版本号，不跟仓库根目录 `VERSION` 绑定。发布包名为 `@ddcat666/open-ai-canvas-agent`。

发布前需要在 GitHub 仓库 Secrets 中配置 `NPM_TOKEN`。

## Codex MCP

衍图唯一 Agent 路线是：

```text
外部 Codex -> 衍图插件 Skill -> yingce MCP stdio -> Runtime /api/tools -> 软件业务服务
```

仓库内插件位于 `plugins/yingce`。在仓库根目录执行：

```powershell
.\scripts\install-yingce-plugin.ps1 -Build
```

脚本会构建当前 `canvas-agent/dist`、刷新插件市场与安装缓存，并把全局 `yingce` MCP 指向当前仓库。发布包的 `.mcp.json` 使用插件内相对启动器，不写死绝对路径。

手工注册时可以使用：

```powershell
codex mcp add yingce -- node D:\path\to\open-ai-canvas\canvas-agent\dist\index.js mcp
```

可用工具包括：

- 画布：`canvas_get_context`、`canvas_find_nodes`、`canvas_apply_ops`、`canvas_create_workflow`、`canvas_get_storyboard`、`canvas_update_storyboard`。
- 生成：`canvas_generate_image`、`canvas_generate_video`、`canvas_generate_audio`、`canvas_merge_videos`。
- 技能：`skill_catalog`、`skill_search`、`skill_read`、`skill_prepare`。
- 模型：`film_list_models`、`film_validate_strategy`。
- 整片：`film_create_run`、`film_get_run`、`film_update_plan`、`film_submit_step`、`film_get_tasks`。
- 验收：`film_probe_media`、`film_check_shot`、`film_render_timeline`、`film_verify_delivery`。
- 诊断：`runtime_diagnostics`。

## Agent 生命周期

- 外部 Codex 活跃时负责创作判断；MCP 提交立即返回 `runId/stepId/attemptId/taskId`，不等待几分钟的生成。
- 软件调度器和任务 worker 只执行已授权计划、既定重试、下载、渲染和验收，不拥有新的开放式创作判断。
- Codex 回合结束不等于影片完成。需要计划外新判断时进入 `WAITING_AGENT`，除非宿主有经验证的继续能力，否则不会偷偷启动内置推理进程。
- 影片只有保存成功、资源可重新读取且必需检查通过后，才允许进入 `COMPLETED`。

## 已移除的内置控制入口

以下 URL 不再注册推理或线程操作，只返回 HTTP 410 / `agent_control_removed`：

```text
/agent/codex/workspace
/agent/codex/threads
/agent/codex/threads/new
/agent/codex/threads/:threadId
/agent/codex/threads/:threadId/resume
/agent/codex/threads/:threadId/delete
/agent/codex/turn
/agent/claude/turn
```

代码中也不再保留 `runCodexTurn`、`runCodexTurnNow`、`CodexAppClient`、`runClaudeTurn` 和 `@openai/codex` 运行依赖。共享 `/api/tools`、事件桥、任务、资源、时间线和手工操作继续保留。