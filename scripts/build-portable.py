# SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
"""Assemble a clean Windows portable edition from explicit build inputs.

No database, live runtime configuration, user media or installed client settings
are read. A new destination is required. The selected donor runtimes are read
only. Build web/dist, canvas-agent/dist and backend/server.exe beforehand.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile


def digest(file: Path) -> str:
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def tree(source: Path, target: Path) -> None:
    if not source.is_dir():
        raise RuntimeError(f"Missing build directory: {source.name}")
    def ignore(directory, names):
        return [name for name in names if name in {".git", "__pycache__", ".cache", ".DS_Store"} or name.endswith((".pyc", ".pyo", ".log", ".download"))]
    shutil.copytree(source, target, ignore=ignore)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--ffmpeg-directory", type=Path, required=True)
    parser.add_argument("--licensed-models", type=Path, required=True,
                        help="Prepared model directory containing only authorized redistributable files")
    parser.add_argument("--runtime-licenses", type=Path, required=True)
    parser.add_argument("--vc-redist-directory", type=Path, required=True)
    parser.add_argument("--zip", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    destination = args.destination.resolve()
    if destination.exists():
        raise SystemExit("Destination must be a new directory")
    version = (root / "VERSION").read_text(encoding="utf-8-sig").strip()
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=root):
        raise SystemExit("Commit source changes before creating the release")
    destination.mkdir(parents=True)
    (destination / "backend").mkdir()
    shutil.copy2(root / "backend/server.exe", destination / "backend/server.exe")
    for name in ["web/dist", "canvas-agent/dist", "canvas-agent/python", "canvas-agent/native",
                 "canvas-agent/node_modules", "plugins", "plugin-packages", "integrations", ".agents", "licenses"]:
        tree(root / name, destination / name)
    # ONNX ships binaries for several OS/architectures. This edition is x64 only.
    onnx_bins = destination / "canvas-agent/node_modules/onnxruntime-node/bin/napi-v6"
    for folder in onnx_bins.iterdir():
        if folder.name != "win32":
            if not folder.resolve().is_relative_to(destination):
                raise RuntimeError("Binary directory escaped the fresh package")
            shutil.rmtree(folder)
    arm = onnx_bins / "win32/arm64"
    if arm.exists():
        if not arm.resolve().is_relative_to(destination):
            raise RuntimeError("Binary directory escaped the fresh package")
        shutil.rmtree(arm)
    for name in ["package.json", "bun.lock"]:
        shutil.copy2(root / "canvas-agent" / name, destination / "canvas-agent" / name)
    (destination / "scripts").mkdir()
    for name in ["start-portable.ps1", "start-axon.ps1", "stop-yingce-local.ps1", "serve-web.mjs",
                 "install-to-codex.ps1", "install-official-h3-guides.ps1", "install-optional-models.ps1",
                 "film-mcp-call.mjs", "film-resource-index.mjs", "build-film-plan.ts", "update-production-skill.mjs"]:
        shutil.copy2(root / "scripts" / name, destination / "scripts" / name)
    for name in ["启动衍图.cmd", "停止衍图.cmd", "start-yingce.cmd", "stop-yingce.cmd", "安装到Codex.cmd",
                 "初始化可选分析模型.cmd", "快速开始.md", "使用说明.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "VERSION"]:
        shutil.copy2(root / name, destination / name)
    (destination / "runtime").mkdir()
    shutil.copy2(args.node, destination / "runtime/node.exe")
    tree(args.ffmpeg_directory, destination / "runtime/ffmpeg")
    tree(args.vc_redist_directory, destination / "runtime/vc-redist")
    tree(args.runtime_licenses, destination / "licenses/runtimes")
    tree(args.licensed_models, destination / "models")
    subprocess.run([str(args.python), str(root / "scripts/collect-portable-python.py"), "--destination", str(destination / "python-runtime")], check=True)
    # MCP needs an existing configuration directory, but never a donor's token.
    (destination / "canvas-agent-config").mkdir()
    (destination / "canvas-agent-config/.keep").write_text("Created empty for each recipient.\n", encoding="utf-8")
    manifest = {
        "formatVersion": 1, "version": version, "sourceCommit": commit, "platform": "windows-x64",
        "modelProvider": "Axon", "modelBaseUrl": "https://zh.heihan.dpdns.org/v1",
        "privateConfigurationIncluded": False, "requiresBuildTools": False,
        "optionalModels": ["OpenPose body and lineart weights require their upstream permissions; see 快速开始.md"],
        "files": [],
    }
    for file in sorted(destination.rglob("*")):
        if file.is_file():
            manifest["files"].append({"path": file.relative_to(destination).as_posix(), "bytes": file.stat().st_size, "sha256": digest(file)})
    (destination / "portable-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"version": version, "sourceCommit": commit, "files": len(manifest["files"]), "uncompressedBytes": sum(file["bytes"] for file in manifest["files"])}), flush=True)
    if args.zip:
        args.zip.parent.mkdir(parents=True, exist_ok=True)
        if args.zip.exists():
            raise SystemExit("Refusing to overwrite an existing archive")
        with zipfile.ZipFile(args.zip, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
            for file in sorted(destination.rglob("*")):
                if file.is_file():
                    archive.write(file, destination.name + "/" + file.relative_to(destination).as_posix())
        with zipfile.ZipFile(args.zip) as archive:
            bad = archive.testzip()
            if bad:
                raise RuntimeError(f"ZIP CRC failed: {bad}")
        print(json.dumps({"archive": args.zip.name, "bytes": args.zip.stat().st_size, "sha256": digest(args.zip), "crcVerified": True}), flush=True)


if __name__ == "__main__":
    main()
