"""Persistent local rembg worker using the explicitly selected ISNet model."""
from __future__ import annotations

import base64
import contextlib
import importlib.util
import io
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from PIL import Image

MODEL_ID = "isnet-general-use"
MODEL_FILENAME = "isnet-general-use.onnx"
MAX_INPUT_BYTES = 12 * 1024 * 1024
DATA_URL_PATTERN = re.compile(r"^data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=_-]+)$")
SESSION: Any = None


def model_home() -> Path:
    value = os.environ.get("CANVAS_CUTOUT_MODEL_HOME")
    if value:
        return Path(value).resolve()
    return (Path(__file__).resolve().parents[2] / ".local" / "cache" / "rembg").resolve()


def emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def ensure_dependencies() -> None:
    """Validate dependencies already installed in the portable Python runtime."""
    if importlib.util.find_spec("rembg") and importlib.util.find_spec("onnxruntime"):
        return
    raise RuntimeError("cutout_dependencies_missing")

def load_session() -> Any:
    global SESSION
    if SESSION is not None:
        return SESSION
    home = model_home()
    home.mkdir(parents=True, exist_ok=True)
    weights_path = home / MODEL_FILENAME
    if not weights_path.is_file() or weights_path.stat().st_size == 0:
        raise RuntimeError("cutout_model_missing")
    # rembg stores isnet-general-use.onnx under U2NET_HOME; set before importing.
    os.environ["U2NET_HOME"] = str(home)
    os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "3")
    try:
        ensure_dependencies()
        from rembg import new_session
        with contextlib.redirect_stdout(sys.stderr):
            SESSION = new_session(MODEL_ID, providers=["CPUExecutionProvider"])
    except Exception as error:
        if str(error) == "cutout_dependencies_missing":
            raise
        raise RuntimeError("cutout_model_missing" if not (home / MODEL_FILENAME).exists() else "cutout_inference_failed") from error
    return SESSION


def image_from_data_url(value: Any) -> Image.Image:
    if not isinstance(value, str):
        raise ValueError("cutout_input_invalid")
    match = DATA_URL_PATTERN.fullmatch(value)
    if not match:
        raise ValueError("cutout_input_invalid")
    try:
        raw = base64.urlsafe_b64decode(match.group(2) + "=" * (-len(match.group(2)) % 4))
        if not raw or len(raw) > MAX_INPUT_BYTES:
            raise ValueError("cutout_input_invalid")
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        image.load()
        return image
    except ValueError:
        raise
    except Exception as error:
        raise ValueError("cutout_input_invalid") from error


def handle(request: dict[str, Any]) -> dict[str, Any]:
    image = image_from_data_url(request.get("dataUrl"))
    try:
        from rembg import remove
        output = remove(image, session=load_session(), force_return_bytes=False)
        if isinstance(output, bytes):
            output = Image.open(io.BytesIO(output))
        if not isinstance(output, Image.Image):
            raise RuntimeError("cutout_inference_failed")
        rgba = output.convert("RGBA")
        # Validate that the result is truly RGBA PNG; rembg's alpha mask must survive serialization.
        encoded = io.BytesIO()
        rgba.save(encoded, format="PNG", optimize=True)
        payload = encoded.getvalue()
        check = Image.open(io.BytesIO(payload))
        if check.mode != "RGBA":
            raise RuntimeError("cutout_inference_failed")
        return {"ok": True, "requestId": request.get("requestId"), "mimeType": "image/png", "width": rgba.width, "height": rgba.height, "modelId": MODEL_ID, "device": "cpu", "pngBase64": base64.b64encode(payload).decode("ascii")}
    except RuntimeError:
        raise
    except Exception as error:
        raise RuntimeError("cutout_inference_failed") from error


def main() -> None:
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    # rembg's model download is stored in U2NET_HOME under the portable .local tree.
    for line in sys.stdin:
        line = line.lstrip("\ufeff").strip()
        if not line:
            continue
        request_id: Any = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("cutout_input_invalid")
            request_id = request.get("requestId")
            emit(handle(request))
        except ValueError as error:
            emit({"ok": False, "requestId": request_id, "code": str(error) or "cutout_input_invalid", "message": "透明抠图输入无效"})
        except RuntimeError as error:
            code = str(error) or "cutout_inference_failed"
            messages = {"cutout_dependencies_missing": "本机抠图依赖安装失败", "cutout_model_missing": "本机 ISNet 抠图模型下载或加载失败", "cutout_inference_failed": "本机透明抠图推理失败"}
            emit({"ok": False, "requestId": request_id, "code": code, "message": messages.get(code, "本机透明抠图推理失败")})
        except Exception:
            emit({"ok": False, "requestId": request_id, "code": "cutout_inference_failed", "message": "本机透明抠图推理失败"})


if __name__ == "__main__":
    main()







