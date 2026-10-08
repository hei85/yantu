# 随包本机模型与来源

v1.6.0-axon.5 完整便携包包含维护者本地现有的五类分析模型及其必需
文件。权重放在发布页的 Windows-x64.zip 中；Git 仓库提供清单、说明
与许可，避免 GitHub 单文件大小限制截断模型。文件 SHA-256 见
`models/LOCAL_MODEL_FILES.json`，完整软件文件见 `portable-manifest.json`。

| 功能 | 模型与位置 | 固定来源版本 |
| --- | --- | --- |
| 深度 | Depth Anything V2 Small，`models/huggingface/hub/models--depth-anything--Depth-Anything-V2-Small-hf/` | `depth-anything/Depth-Anything-V2-Small-hf` / `5426e4f0f36572d16453bbda7a8389317b1bef99` |
| 抠图 | ISNet general use，`models/rembg/isnet-general-use.onnx` | 本地原文件；同目录保留 `MODEL_SOURCE.txt` 与 `LICENSE-DIS.md` |
| 姿态 | OpenPose body-only，Annotators 快照的 `body_pose_model.pth` | `lllyasviel/Annotators` / `982e7edaec38759d914a963c48c4726685de7d96` |
| AI 线稿 | 同一 Annotators 快照的 `sk_model.pth` 与 `sk_model2.pth` | 同上，两个模型文件均保留 |
| 对白识别 | `runtime/h3-audio-audit/models/whisper-base/`，包含权重、配置、预处理与分词文件 | `openai/whisper-base` / `e37978b90ca9030d5170a5c07aadb050351a65bb` |

来源：

- 深度：<https://github.com/DepthAnything/Depth-Anything-V2>，Small 采用 Apache-2.0。
- 抠图：<https://github.com/xuebinqin/DIS> / <https://github.com/danielgatis/rembg>，保留本地来源说明与 Apache-2.0 全文。
- 姿态与线稿快照：<https://huggingface.co/lllyasviel/Annotators/tree/982e7edaec38759d914a963c48c4726685de7d96>。
- OpenPose 原项目：<https://github.com/CMU-Perceptual-Computing-Lab/openpose>；其原许可全文见 `licenses/OpenPose-LICENSE.txt`，使用权按原作者条款执行。
- 线稿上游：<https://github.com/carolineec/informative-drawings>；保留其 MIT 许可全文，模型来源仍记录为上述 Annotators 快照。
- Whisper 模型：<https://huggingface.co/openai/whisper-base/tree/e37978b90ca9030d5170a5c07aadb050351a65bb>；保留该模型卡与 Apache-2.0 全文。
- Whisper 原项目：<https://github.com/openai/whisper>；同时保留原项目 MIT 许可。

这些模型和第三方文件不按衍图自有新增代码许可重新授权。随包保留
来源与原条款，不将模型复制或文件哈希一致描述成获得了额外授权。

启动器为深度、姿态和线稿设置随包 Hugging Face 缓存目录及快照指针，
抠图使用随包 rembg 目录。声音检查脚本直接从 Whisper 的本地目录加载，
并优先使用随包 FFmpeg / FFprobe。模型文件的完整性核对不代表已经
实际推理通过；对白的 ASR 结果也不能替代视觉审看与听审。
