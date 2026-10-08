---
name: open-canvas
description: 打开、启动或恢复本便携版衍图与 Canvas Agent MCP；用户要求连接画布、重启软件或当前工具断连时使用。
metadata:
  version: "1.1.0"
---

# 连接正确的便携包

本插件启动器读取安装脚本登记的 runtimeRoot 指针，使用该包的 Node、Canvas Agent 和本地配置；Codex 缓存目录不等于运行目录。先调用 `runtime_diagnostics` 与 `canvas_list_open_canvases`。

- `runtime_unreachable`：本地控制服务未连接，检查实际登记目录和该包服务进程。用户要求启动/重启时使用本包启动脚本，避免创建另一份服务。
- Runtime 在线但画布列表为空：目标页面尚未打开/同步，打开正确画布并等待连接。页面离线不等于生成失败。
- 多画布：按用户目标明确 canvasId；同画布多标签读取用 clientId，写入要先解除重复标签歧义。
- `runtime_authorization_failed` 或配置不匹配：核对本包指针和配置，不把 API 渠道密钥当 Runtime 授权，不绕过检查。

按已有工具能力恢复，浏览器自动安全检查拒绝时说明被拒绝的动作与原因，不换隐藏手段绕过。恢复后重读 revision/stateHash，再查询原 taskId/clientOperationId 和资源；不重新创建已完成画布，不重发仍运行的收费请求。

单纯连接先只读，测试性创建/删除需要用户要求并使用独立测试画布。继续整片制作时再加载相关制作规则，用户已采用的图片和视频保留。
