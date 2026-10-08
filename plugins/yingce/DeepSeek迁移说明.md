# 衍图插件位置与DeepSeek Harness迁移说明

核实日期：2026-10-05。

## 软件包里在哪里找

完整便携目录下的plugins/yingce就是当前插件本体，包含.codex-plugin/plugin.json、.mcp.json、skills、scripts和README.md。Codex的用户缓存不是软件包内插件的唯一来源。

完整打包并解压便携目录即可找到这些文件；只打包启动exe/cmd不能带齐插件和运行时。对方使用Codex时，在新解压目录运行安装到Codex.cmd重新注册，再启动衍图并加载新会话。

## 官方DeepSeek Harness可以复用什么

官方MCP客户端支持本地stdio与Streamable HTTP；官方本地技能提供者识别<技能名>/SKILL.md。衍图的底层MCP和技能可以按这些接口迁移。当前.codex-plugin清单是Codex格式，不是可直接安装的Harness原生插件包；本说明没有把文档支持当作实际连接通过。

MCP使用当前软件目录的runtime/node.exe，参数为canvas-agent/dist/index.js和mcp；环境变量FRAMEFIELD_LOCAL_RUNTIME_CONFIG_DIR指向canvas-agent-config，YINGCE_RUNTIME_ROOT指向同一软件目录。每次搬迁均替换为对方电脑的实际绝对路径。

Harness中通过@deepseek-ai/dsh-mcp-client注册serverName=yingce、transport=stdio与上述command/args/env。官方本地技能插件@deepseek-ai/dsh-skill-filesystem可通过customSkillDirs指向当前软件的plugins/yingce/skills目录；扫描根必须直接包含各技能目录，不要指向plugins或整份ZIP的上层。

先启动正确便携软件与画布，再核对Harness是否列出衍图工具与技能并读取目标画布。此步骤尚未在用户的DeepSeek桌面端实测，也未修改或安装其客户端。

## 官方依据

- MCP：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md
- Skills：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md
