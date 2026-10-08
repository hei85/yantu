<p align="center"><img src="web/public/logo.png" width="96" alt="衍图"></p>

# 衍图 · Axon 发行版

面向影视与短剧创作的画布工作台：剧本、角色与场景资产、关键画面、
视频生成、导演机位、声音、时间线、质量检查与 MCP 自动化。

这是 [hei85/yantu](https://github.com/hei85/yantu) 原项目的后续版本。
此 GitHub 发行版的模型服务固定为 **Axon**，不接受其他中转站地址或
手工新增任意模型 ID。使用者填写自己的 Axon API Key，然后从真实
模型目录拉取并导入模型。本仓库不包含任何人的渠道密钥。

## 本次包含

- 完整前端 `web/`、Go 后端 `backend/`、Canvas MCP 服务 `canvas-agent/`。
- Codex 插件、可迁移的 MCP 启动器、制作技能与调用规则。
- 声明式模型协议插件与 Axon 工作流集成代码。
- 固定室内空间的房型、共用模型、机位和距离约束；关键四宫格拆图与连续性规则。
- 持久任务、幂等重试、真实资源绑定、媒体探测、自检、剪辑与时间线交付流程。
- 模型目录空值防护、分辨率能力来源与实测证据；图片预览和视频结果恢复相关代码。

不包含私人项目、生成媒体、数据库、日志、运行时密钥、Node / Python
运行时或额外下载的分析模型权重。网页已有的第三方 WASM 与小型人脸
检测模型保留在 public 目录，沿用其原许可。

## Windows 源码启动

准备 Git、**Node.js 22.13+**、Bun、Go 1.25，以及 SQLite 编译所需的
GCC / MinGW-w64，并加入 PATH。影视合成另需 FFmpeg / FFprobe。

```powershell
git clone https://github.com/hei85/yantu.git
cd yantu
.\start-yingce.cmd
```

也可双击 `启动衍图.cmd`。首次启动安装锁定依赖并编译，可能较久；
以后直接使用编译结果。源码更新后运行：

```powershell
.\scripts\start-axon.ps1 -Rebuild
```

网页为 `http://localhost:3000`，后端为 `127.0.0.1:8080`，MCP Runtime
为 `127.0.0.1:17371`。Windows 启动器仅监听本机，自动建立本机使用
身份，无需填写旧版本账号。数据在本目录 `.local/` 和
`canvas-agent-config/`，停止用 `停止衍图.cmd`。

进入 **设置 → 模型中心**，填写自己的 Axon API Key，保存后拉取目录
并选择导入。分辨率、画幅、时长优先使用目录声明；未声明时显示来源
明确的推断或“渠道默认”，不能把推断说成实测支持。

## MCP 与技能

先启动软件，打开目标画布，然后运行 `安装到Codex.cmd`。
安装或更新后重新连接 MCP / 打开新对话。插件位于
`plugins/yingce/`，包含技能、图标、清单和启动器，不依赖维护者的电脑路径。

其他支持本地 stdio MCP 的客户端可配置：

```json
{
  "mcpServers": {
    "yingce": {
      "command": "node",
      "args": ["<你的绝对路径>/yantu/plugins/yingce/scripts/start-mcp.mjs", "mcp"],
      "env": {
        "CANVAS_PROJECT_ROOT": "<你的绝对路径>/yantu",
        "FRAMEFIELD_LOCAL_RUNTIME_CONFIG_DIR": "<你的绝对路径>/yantu/canvas-agent-config"
      }
    }
  }
}
```

不同客户端的插件注册格式可能不同；能配置 MCP 不代表已在每种客户端
实测。先调用 `runtime_diagnostics` 和 `canvas_list_open_canvases`。
详见 [插件说明](plugins/yingce/README.md) 与
[整片制作技能](plugins/yingce/skills/yingce-film-production/SKILL.md)。

MiniMax H3 官方指南在首次启动时从固定官方提交下载并校验，仅保存在
本机；失败时运行 `scripts/install-official-h3-guides.ps1` 重试。本地
中文适配与自检规则随源码提供。其他模型使用对应技能和真实能力。

图片分析 Python 环境可选运行 `scripts/setup-image-analysis.ps1`；
首次使用部分模型还需下载其权重。

## 剧本到成片

1. 解析剧本、时长、画风与声音，检查实际模型能力和已有资产。
2. 封闭场景先采用房型图，建立共用空间模型，再锁定摄影机与物体坐标；
   户外按场景连续性规划，不强制套室内建模步骤。
3. 规划镜头与必要过渡，四格表达四个关键状态，拆成独立图片后验收。
4. 每镜绑定真实独立切图和必要身份、场景及前镜状态。前镜结束图用于
   承接，新镜第一格是推进后的新时刻。输入上限以当前渠道能力为准。
5. 提交真实视频任务，返回后检查顺序、空间、道具、像素、对白和衔接。
   超时先查原任务，避免重复付费。
6. 剪除违规或多余内容、处理不合适声音，纳入实际过渡段，渲染并检查
   最终文件。默认无字幕；ASR 不能替代听审，生成成功不能代替验收。

规则支持自动化和失败恢复，不保证任何上游模型永远生成无误。
发行约束及验证范围见 [发行说明](release/AXON-DISTRIBUTION.md)。

## 许可

自有且未另行授权的新增内容允许查看与原样使用；修改、再发布须取得
hei85 授权。已有 MIT 和第三方内容保留原许可，不追溯收回旧授权。
这是有使用限制的源码公开发行。详见 [LICENSE](LICENSE)、
[NOTICE](NOTICE) 和 [第三方说明](THIRD_PARTY_NOTICES.md)。
