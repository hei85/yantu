---
name: h3-prompt-writing
description: 加载固定官方版本的 MiniMax H3 提示词指南；按真实模式读取基础或全参考指南，并使用相邻中文适配与连续性规则。
metadata:
  source: https://github.com/MiniMax-AI/MiniMax-H3
  upstream_commit: d21241f0a4b3acbb34c97dae47fa417b7065e438
---

# MiniMax H3 官方指南入口

本文件是本项目的加载适配，不是 MiniMax 官方指南全文。

1. 确认当前模型确为 H3，并读取当前渠道的实际能力。
2. 先读取 `references/upstream-SKILL.md`，再按模式读取指南：
   文本、首帧、首尾帧、尾帧模式使用 `references/base-en.txt`，
   全参考模式使用 `references/ref-en.txt`。
3. 如果文件不存在，请从软件根目录执行
   `scripts/install-official-h3-guides.ps1`。它只下载固定官方提交并
   校验 SHA-256，不执行下载内容。首次源码启动也会尝试此操作。
4. 按用户语言要求及相邻 `minimax-h3-prompt/SKILL.md` 完成本地适配；
   字段、引用标签与模式结构按官方指南，输入数量和分辨率按真实渠道。
5. 前镜结束图仅迁移连续状态，新镜首格必须发展动作；真实独立切图、
   面板绑定、原生内联引用和实际输入顺序保持一致。
6. 无法读取官方指南时报告具体缺口，不能声称已应用官方指南。

官方来源：https://github.com/MiniMax-AI/MiniMax-H3/tree/d21241f0a4b3acbb34c97dae47fa417b7065e438/skills/h3-prompt-writing
官方内容的权利与条款归原发布者；下载结果只保存在本机，不纳入本仓库
的再授权。项目自有适配按根目录 LICENSE，第三方例外见 THIRD_PARTY_NOTICES.md。
