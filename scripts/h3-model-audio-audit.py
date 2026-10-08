#!/usr/bin/env python3
"""Locally inspect a short H3 video/audio sample for audio activity and Chinese speech."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIR = ROOT / "runtime" / "h3-audio-audit"
DEFAULT_MODEL_DIR = RUNTIME_DIR / "models" / "whisper-base"
FFMPEG_ROOT = RUNTIME_DIR / "ffmpeg"


def run(command: list[str], *, timeout: int = 180) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def resolve_binary(name: str, explicit: str | None) -> str:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    candidates.append(FFMPEG_ROOT / "bin" / f"{name}.exe")
    candidates.append(ROOT / "runtime" / "ffmpeg" / "bin" / f"{name}.exe")
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    if FFMPEG_ROOT.is_dir():
        bundled = next(FFMPEG_ROOT.rglob(f"{name}.exe"), None)
        if bundled is not None:
            return str(bundled)
    from_path = shutil.which(name) or shutil.which(f"{name}.exe")
    if from_path:
        return from_path
    raise RuntimeError(f"找不到 {name}。请将 FFmpeg essentials 解压到 {FFMPEG_ROOT}，或使用 --{name} 指定路径。")


def normalize_phrase(value: str) -> str:
    return "".join(char.lower() for char in value if char.isalnum() or "\u3400" <= char <= "\u9fff")


def compare_phrase(expected: str, recognized: str) -> tuple[bool, bool]:
    """Compare punctuation-normalized ASR text without accepting extra words."""
    expected_normalized = normalize_phrase(expected)
    recognized_normalized = normalize_phrase(recognized)
    if not expected_normalized or not recognized_normalized:
        return False, False
    return recognized_normalized == expected_normalized, expected_normalized in recognized_normalized


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def probe(ffprobe: str, media: Path) -> dict[str, Any]:
    result = run([
        ffprobe, "-v", "error", "-show_entries",
        "format=filename,format_name,duration,size:stream=index,codec_type,codec_name,sample_rate,channels,channel_layout,duration",
        "-of", "json", str(media),
    ])
    return json.loads(result.stdout)


def analyze_levels(ffmpeg: str, media: Path, audio_duration: float) -> dict[str, Any]:
    result = run([
        ffmpeg, "-hide_banner", "-nostats", "-i", str(media), "-map", "0:a:0",
        "-af", "volumedetect,silencedetect=noise=-50dB:d=0.1", "-f", "null", "-",
    ])
    log = result.stderr
    mean_match = re.findall(r"mean_volume:\s*(-?\d+(?:\.\d+)?) dB", log)
    max_match = re.findall(r"max_volume:\s*(-?\d+(?:\.\d+)?) dB", log)
    mean_db = float(mean_match[-1]) if mean_match else None
    peak_db = float(max_match[-1]) if max_match else None
    silence_durations = [float(value) for value in re.findall(r"silence_duration:\s*(\d+(?:\.\d+)?)", log)]
    silent_seconds = min(audio_duration, sum(silence_durations)) if audio_duration > 0 else sum(silence_durations)
    return {
        "meanVolumeDb": mean_db,
        "maxVolumeDb": peak_db,
        "peakHeadroomDb": round(-peak_db, 2) if peak_db is not None else None,
        "signalDetected": peak_db is not None and peak_db > -50,
        "peakCaution": "峰值已非常接近 0 dBFS；请听验是否刺耳或失真。接近满刻度不是音质合格证明。" if peak_db is not None and peak_db >= -1.0 else "响度测量不能单独判定语音清晰度、背景噪声或音质。",
        "silenceThresholdDb": -50,
        "silenceMinDurationSeconds": 0.1,
        "silentSecondsDetected": round(silent_seconds, 3),
        "silenceRatio": round(silent_seconds / audio_duration, 4) if audio_duration > 0 else None,
        "activityInterpretation": "检测到高于 -50 dB 静音阈值的音频活动；这可能是环境声、音乐或语音，不能单独证明有人说话。",
    }


class LocalWhisper:
    """Keep one CPU model loaded and reuse it across every manifest entry."""

    def __init__(self, model_dir: Path):
        if not model_dir.is_dir() or not (model_dir / "model.safetensors").is_file():
            raise RuntimeError(f"本地 Whisper 模型不存在或不完整：{model_dir}。请先下载 openai/whisper-base。")
        import torch
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor

        self.torch = torch
        self.processor = AutoProcessor.from_pretrained(str(model_dir), local_files_only=True)
        self.model = AutoModelForSpeechSeq2Seq.from_pretrained(str(model_dir), local_files_only=True)
        self.model.eval()
        self.model_dir = model_dir

    def transcribe(self, audio: Any, sample_rate: int) -> str:
        inputs = self.processor(audio, sampling_rate=sample_rate, return_tensors="pt")
        with self.torch.inference_mode():
            predicted_ids = self.model.generate(inputs.input_features, language="chinese", task="transcribe")
        return str(self.processor.batch_decode(predicted_ids, skip_special_tokens=True)[0]).strip()


def transcribe_local(ffmpeg: str, media: Path, recognizer: LocalWhisper) -> str:
    import soundfile as sf

    with tempfile.TemporaryDirectory(prefix="h3-audio-audit-") as temporary:
        wav_path = Path(temporary) / "audio-16k-mono.wav"
        run([
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(media), "-map", "0:a:0",
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav_path),
        ])
        audio, sample_rate = sf.read(str(wav_path), dtype="float32", always_2d=False)
        if sample_rate != 16000:
            raise RuntimeError(f"FFmpeg 采样率错误：{sample_rate} Hz，预期 16000 Hz")
        if audio.size == 0:
            raise RuntimeError("提取的音频为空")
        return recognizer.transcribe(audio, sample_rate)


def write_report(path: Path, report: dict[str, Any]) -> None:
    audio = report["audio"]
    lines = [
        "# H3 音频/对白检查",
        "",
        f"- 文件：`{report['input']['path']}`",
        f"- SHA-256：`{report['input']['sha256']}`",
        f"- 媒体时长：{report['media']['durationSeconds']} 秒",
        f"- 音轨：{'存在' if audio['present'] else '未发现'}",
    ]
    for stream in audio["streams"]:
        lines.append(f"  - stream {stream.get('index')}：{stream.get('codec_name')}，{stream.get('sample_rate', '?')} Hz，{stream.get('channels', '?')} 声道")
    if audio.get("levels"):
        levels = audio["levels"]
        lines.extend([
            f"- 音量：mean {levels['meanVolumeDb']} dB，peak {levels['maxVolumeDb']} dB；近静音占比 {levels['silenceRatio']}",
            f"- 峰值提示：{levels['peakCaution']}",
        ])
    lines.extend([
        f"- Whisper-base（本地中文转写）：{report['asr'].get('text') or '（未识别到文字）'}",
        f"- 期望短句：{report['expectedPhrase'] or '未提供'}",
        f"- 短句检查：{report['phraseCheck']['status']}",
        f"- 人声/对白验收：{report['speechAssessment']['status']}",
    ])
    alternate = report["asr"].get("alternateDecode")
    if alternate:
        lines.append(f"- Whisper-base beam-5 复核：{alternate.get('text') or '（未识别到文字）'}；全文精确匹配：{'是' if alternate.get('exactPhraseMatch') else '否'}")
    source_audio = report.get("referenceAudioWaveformComparison")
    if source_audio:
        lines.append(f"- 参考音频波形相关：{source_audio.get('maxNormalizedCorrelation')}，偏移 {source_audio.get('bestOffsetSeconds')} 秒；{source_audio.get('interpretation')}")
    metadata = report.get("metadata") or {}
    if metadata.get("model"):
        lines.append(f"- 型号：`{metadata['model']}`")
    if report.get("referenceComparison"):
        comparison = report["referenceComparison"]
        lines.append(f"- 相对参考语音音量差：mean {comparison['meanVolumeDeltaDb']} dB，peak {comparison['peakVolumeDeltaDb']} dB（只表示响度差，不是质量判断）")
    lines.extend(["", "## 判断限制", ""])
    lines.extend(f"- {item}" for item in report["limitations"])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def root_path(value: str | Path) -> Path:
    path = Path(value).expanduser()
    return path.resolve() if path.is_absolute() else (ROOT / path).resolve()


def load_manifest(path: Path) -> list[dict[str, Any]]:
    document = json.loads(path.read_text(encoding="utf-8"))
    defaults = document.get("defaults", {}) if isinstance(document, dict) else {}
    entries = document.get("items", []) if isinstance(document, dict) else document
    if not isinstance(entries, list):
        raise ValueError("manifest 必须是条目数组或含 items 数组的对象")
    normalized: list[dict[str, Any]] = []
    for item in entries:
        if not isinstance(item, dict) or not item.get("media"):
            continue
        normalized.append({**defaults, **item})
    return normalized


def make_report(media: Path, expected_phrase: str | None, model_dir: Path, metadata: dict[str, Any], ffmpeg: str, ffprobe: str, get_recognizer) -> dict[str, Any]:
    if not media.is_file():
        raise FileNotFoundError(f"输入文件不存在：{media}")
    probed = probe(ffprobe, media)
    streams = probed.get("streams", [])
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    duration = float((probed.get("format") or {}).get("duration") or 0)

    report: dict[str, Any] = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "input": {"path": str(media), "sizeBytes": media.stat().st_size, "sha256": sha256_file(media)},
        "media": {"format": (probed.get("format") or {}).get("format_name"), "durationSeconds": round(duration, 3), "videoStreams": video_streams},
        "audio": {"present": bool(audio_streams), "streams": audio_streams, "levels": None},
        "asr": {"modelId": "openai/whisper-base", "modelPath": str(model_dir), "runtime": "Transformers local generation / CPU", "text": None, "error": None},
        "expectedPhrase": expected_phrase,
        "metadata": {key: metadata[key] for key in ("resourceId", "model", "caseId", "role") if metadata.get(key) is not None},
        "phraseCheck": {
            "asrExpectedPhraseMatch": None,
            "asrContainsExpectedPhrase": None,
            "expectedNormalized": normalize_phrase(expected_phrase) if expected_phrase is not None else None,
            "recognizedNormalized": None,
            "status": "未证实：没有提供 expected phrase。" if expected_phrase is None else "未证实：没有可转写的音轨。",
        },
        "speechAssessment": {
            "status": "未证实：音轨存在、响度或单次 ASR 输出不能代替人声/对白听验。",
            "voicePresent": None,
            "chineseDialogueAudiblyClear": None,
            "requiresHumanListening": True,
        },
        "limitations": [
            "音轨存在或有音量只证明存在音频信号，可能是雨声、脚步、音乐或其他环境声，不能单独证明有人声或对白。",
            "ASR 未识别到文字不能证明没有说话；很短的 2–3 秒片段、背景噪声、口音和混音可能降低中文识别率。",
            "Whisper 可能在环境声或非语音上臆测一两个字；极短转写需复听，不能单凭转写判定有人对白。",
            "ASR 命中短句是机器转写证据，关键样片仍应由人耳确认是否清晰可听、是否确为中文对白。",
        ],
    }

    if audio_streams:
        report["audio"]["levels"] = analyze_levels(ffmpeg, media, duration)
        if duration < 0.25:
            report["asr"]["error"] = "片段短于 0.25 秒，跳过 ASR。"
        else:
            try:
                recognizer = get_recognizer()
                report["asr"]["text"] = transcribe_local(ffmpeg, media, recognizer)
            except Exception as error:  # Report dependency/model errors without losing ffprobe and loudness evidence.
                report["asr"]["error"] = f"{type(error).__name__}: {error}"
        if expected_phrase is not None:
            expected = normalize_phrase(expected_phrase)
            recognized = normalize_phrase(report["asr"].get("text") or "")
            report["phraseCheck"]["recognizedNormalized"] = recognized
            if report["asr"].get("error"):
                report["phraseCheck"]["asrExpectedPhraseMatch"] = None
                report["phraseCheck"]["asrContainsExpectedPhrase"] = None
                report["phraseCheck"]["status"] = "未证实：ASR 未成功运行。"
            else:
                exact_match, contains_phrase = compare_phrase(expected, recognized)
                report["phraseCheck"]["asrExpectedPhraseMatch"] = exact_match
                report["phraseCheck"]["asrContainsExpectedPhrase"] = contains_phrase
                if exact_match:
                    report["phraseCheck"]["status"] = "ASR 转写仅为期望短句；仍需听验发音、音质和内容。"
                elif contains_phrase:
                    report["phraseCheck"]["status"] = "ASR 包含期望短句但还有额外识别内容；不按准确短句通过，需听验。"
                else:
                    report["phraseCheck"]["status"] = "未证实：ASR 未命中完整期望短句；这不是‘没有对白’的证明。"

    return report


def save_report(output: Path, report: dict[str, Any]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_report(output.with_suffix(".md"), report)


class AuditRunner:
    def __init__(self, model_dir: Path, ffmpeg: str, ffprobe: str):
        self.model_dir = model_dir
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.recognizer: LocalWhisper | None = None

    def get_recognizer(self) -> LocalWhisper:
        if self.recognizer is None:
            print("Loading local Whisper-base once…", flush=True)
            self.recognizer = LocalWhisper(self.model_dir)
        return self.recognizer

    def audit(self, entry: dict[str, Any], default_phrase: str | None = None) -> tuple[Path, dict[str, Any]]:
        media = root_path(entry["media"])
        resource_id = str(entry.get("resourceId") or media.stem)
        output = root_path(entry.get("output") or f"audio-audits/{resource_id}.json")
        phrase = entry.get("expectedPhrase", default_phrase)
        metadata = {key: entry.get(key) for key in ("resourceId", "model", "caseId", "role")}
        report = make_report(media, phrase, self.model_dir, metadata, self.ffmpeg, self.ffprobe, self.get_recognizer)
        save_report(output, report)
        print(json.dumps({
            "resourceId": resource_id,
            "model": metadata.get("model"),
            "json": str(output),
            "seconds": report["media"]["durationSeconds"],
            "audio": report["audio"]["present"],
            "meanDb": report["audio"]["levels"]["meanVolumeDb"] if report["audio"]["levels"] else None,
            "peakDb": report["audio"]["levels"]["maxVolumeDb"] if report["audio"]["levels"] else None,
            "asr": report["asr"]["text"],
            "expectedMatch": report["phraseCheck"]["asrExpectedPhraseMatch"],
            "phraseStatus": report["phraseCheck"]["status"],
        }, ensure_ascii=False))
        return output, report


def add_reference_comparison(candidate: dict[str, Any], reference: dict[str, Any], reference_id: str) -> None:
    candidate_levels = candidate["audio"].get("levels") or {}
    reference_levels = reference["audio"].get("levels") or {}
    candidate_mean, reference_mean = candidate_levels.get("meanVolumeDb"), reference_levels.get("meanVolumeDb")
    candidate_peak, reference_peak = candidate_levels.get("maxVolumeDb"), reference_levels.get("maxVolumeDb")
    candidate["referenceComparison"] = {
        "referenceResourceId": reference_id,
        "meanVolumeDeltaDb": round(candidate_mean - reference_mean, 2) if candidate_mean is not None and reference_mean is not None else None,
        "peakVolumeDeltaDb": round(candidate_peak - reference_peak, 2) if candidate_peak is not None and reference_peak is not None else None,
        "interpretation": "相对响度差仅用于定位显著偏低/偏高样本，不等同于音质、噪声或对白清晰度评价。",
    }


def analyze_entries(runner: AuditRunner, entries: list[dict[str, Any]], default_phrase: str | None) -> list[tuple[dict[str, Any], Path, dict[str, Any]]]:
    ordered = sorted(entries, key=lambda item: item.get("role") != "reference")
    completed: list[tuple[dict[str, Any], Path, dict[str, Any]]] = []
    for entry in ordered:
        try:
            output, report = runner.audit(entry, default_phrase)
            completed.append((entry, output, report))
        except Exception as error:
            print(json.dumps({"resourceId": entry.get("resourceId"), "error": f"{type(error).__name__}: {error}"}, ensure_ascii=False), file=sys.stderr)

    by_resource = {str(entry.get("resourceId")): report for entry, _, report in completed if entry.get("resourceId")}
    for entry, output, report in completed:
        reference_id = entry.get("referenceResourceId")
        if reference_id:
            reference = by_resource.get(str(reference_id))
            if reference is None:
                reference_path = ROOT / "audio-audits" / f"{reference_id}.json"
                if reference_path.is_file():
                    reference = json.loads(reference_path.read_text(encoding="utf-8"))
            if reference is not None:
                add_reference_comparison(report, reference, str(reference_id))
                save_report(output, report)
    return completed


def main() -> int:
    parser = argparse.ArgumentParser(description="本地检查 H3 视频/音频的音轨、响度、静音和中文对白。音频不会上传到外部服务。")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--media", help="单个视频或音频文件路径")
    source.add_argument("--manifest", help="批量清单 JSON；同一进程只加载一次 Whisper 模型")
    source.add_argument("--watch-manifest", help="监视 JSON 清单变化并处理新增稳定文件；Ctrl+C 停止")
    parser.add_argument("--expected-phrase", help="默认预期短句；清单条目可单独覆盖")
    parser.add_argument("--output", help="单个文件的 JSON 报告路径；批量默认写 audio-audits/<resourceId>.json")
    parser.add_argument("--model-dir", default=str(DEFAULT_MODEL_DIR), help="本地 Whisper 模型目录")
    parser.add_argument("--ffmpeg", help="可选：ffmpeg 可执行文件路径")
    parser.add_argument("--ffprobe", help="可选：ffprobe 可执行文件路径")
    parser.add_argument("--poll-seconds", type=float, default=3.0, help="监视模式清单重读间隔")
    args = parser.parse_args()

    model_dir = root_path(args.model_dir)
    ffmpeg = resolve_binary("ffmpeg", args.ffmpeg)
    ffprobe = resolve_binary("ffprobe", args.ffprobe)
    runner = AuditRunner(model_dir, ffmpeg, ffprobe)

    if args.media:
        if not args.output:
            parser.error("单文件模式必须提供 --output")
        entry = {"media": args.media, "output": args.output, "expectedPhrase": args.expected_phrase}
        runner.audit(entry)
        return 0

    manifest_path = root_path(args.manifest or args.watch_manifest)
    if args.manifest:
        entries = load_manifest(manifest_path)
        completed = analyze_entries(runner, entries, args.expected_phrase)
        return 0 if len(completed) == len(entries) else 1

    seen: set[tuple[str, int, int]] = set()
    stability: dict[str, tuple[tuple[int, int], int]] = {}
    print(f"Watching {manifest_path}; Whisper loads once when the first stable audio entry arrives.", flush=True)
    try:
        while True:
            for entry in load_manifest(manifest_path):
                media = root_path(entry["media"])
                if not media.is_file():
                    continue
                stat = media.stat()
                signature = (stat.st_size, stat.st_mtime_ns)
                previous, count = stability.get(str(media), (signature, 0))
                count = count + 1 if signature == previous else 0
                stability[str(media)] = (signature, count)
                if count < 1:
                    continue
                key = (str(media), stat.st_size, stat.st_mtime_ns)
                if key in seen:
                    continue
                try:
                    completed = analyze_entries(runner, [entry], args.expected_phrase)
                    if completed:
                        seen.add(key)
                except Exception as error:
                    print(json.dumps({"resourceId": entry.get("resourceId"), "error": f"{type(error).__name__}: {error}"}, ensure_ascii=False), file=sys.stderr)
            import time
            time.sleep(max(0.5, args.poll_seconds))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f"audio audit failed: {error}", file=sys.stderr)
        raise SystemExit(2)
