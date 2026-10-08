# 来源与许可范围

本文件与根目录 LICENSE、NOTICE 一起使用。原有授权继续有效。

| 内容 | 来源与适用许可 |
| --- | --- |
| Infinite Canvas 基础 | basketikun/infinite-canvas，v0.5.0 / 568f0f1838df8de31fe885a4e130e2f346dd14ab；MIT 见 licenses/MIT-upstream.txt |
| Open AI Canvas 与本仓库此前 MIT 内容 | ddcat-ai/open-ai-canvas；保留 MIT 授权和作者署名 |
| hei85 自有且未另行授权的新增内容 | 根目录 LICENSE；明确标注文件采用 LicenseRef-Yantu-Source-Available |
| Higgsfield 提示词技能树 | plugins/yingce/skills/higgsfield-ai-prompt-skill/，O-Side Media，沿用该目录 LICENSE（MIT） |
| MiniMax H3 官方指南 | https://github.com/MiniMax-AI/MiniMax-H3；不将官方全文重新授权，提供本地适配与固定上游下载脚本 |
| Remotion 等外部工具说明与技能 | 保留原来源，不对第三方内容主张 hei85 的限制性许可；软件和服务按各自条款使用 |
| Go、Node 与 Python 依赖 | go.mod、package.json / bun.lock 记录源码依赖；便携包保留各依赖原许可、Python portable-packages.json 和文件校验清单，不适用自有新增部分限制 |
| Node.js v24.18.0 | MIT 及所带第三方许可；便携包 licenses/runtimes/Node-v24.18.0-LICENSE.txt |
| Python 3.11.9 | PSF 及所带第三方许可；便携包 python-runtime/LICENSE.txt；各 wheel 的 dist-info / licenses 保留 |
| Microsoft Visual C++ Runtime | 随包提供微软签名的原版 vc_redist.x64.exe，缺少运行库时显示其原生安装器与许可，不修改安装器或对其重新授权；来源 https://aka.ms/vs/17/release/vc_redist.x64.exe |
| FFmpeg / FFprobe 9.0.1，Gyan full build | GPLv3；便携包 runtime/ffmpeg/LICENSE、README.txt 和 version.txt；同一发布页提供对应 FFmpeg 源码与构建记录，第三方部分保留原权利 |
| @ffmpeg/core 0.12.10 浏览器 WASM | GPL-2.0-or-later；来源 https://github.com/ffmpegwasm/ffmpeg.wasm；同一发布页提供该版本发布提交 71aa99d37c02a7b4c435275ca9ef50e612f6efa1 对应源码、原构建脚本与版本记录，未按衍图限制性许可重新授权 |
| Depth Anything V2 Small | Apache-2.0；仅 Small 权重随包，固定版本与来源见 models/MODEL_NOTICES.md，不包含其他许可的 Base / Large / Giant 权重 |
| ISNet general use | Apache-2.0；便携包 models/rembg/LICENSE-DIS.md 与 MODEL_SOURCE.txt |
| OpenPose / lineart 权重 | 不随包再分发；可选初始化从原作者下载并要求使用者先确认相应许可，OpenPose 有非商业限制；原许可参考见 licenses/runtimes/OpenPose-LICENSE-not-bundled.txt |
| 模型图标与商标 | 属于原权利人，仅供识别，不表示认可本发行版 |
| MediaPipe Vision WASM、BlazeFace 检测模型 | Google / MediaPipe，Apache-2.0；路径 web/public/mediapipe/ 与 web/public/canvas/models/，许可全文见 licenses/Apache-2.0.txt，来源 https://github.com/google-ai-edge/mediapipe |
| Basis Universal 转码器 | Copyright (C) 2019–2026 Binomial LLC；web/public/three/basis/，Apache-2.0，来源 https://github.com/BinomialLLC/basis_universal；许可全文见 licenses/Apache-2.0.txt |

H3 官方指南固定为提交 d21241f0a4b3acbb34c97dae47fa417b7065e438，
校验值写在 scripts/install-official-h3-guides.ps1。下载结果只在使用者
本地，不纳入本仓库；使用前应阅读上游适用授权与条款。

这些第三方文件不适用 hei85 自有新增部分的限制。如发现来源或授权
登记不完整，请通过本仓库 Issue 联系维护者。

便携版是独立组件的合集。FFmpeg、Node、Python、依赖与模型不是按
衍图限制性许可重新授权；相关部分的查看、修改、复制与再分发权利
按其各自许可证执行。对应源码与构建记录入口见发布页。
