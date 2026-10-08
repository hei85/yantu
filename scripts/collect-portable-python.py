# SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
"""Copy installed application dependencies by wheel RECORD, never user caches.

Run with the Python installation selected as the donor. The destination must be
new. This is a maintainer build tool, not a step required of end users.
"""
from __future__ import annotations

import argparse
import importlib.metadata as metadata
import json
from pathlib import Path
import shutil
import sys

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    destination = args.destination.resolve()
    if destination.exists():
        raise SystemExit("Python destination must not already exist")
    donor = Path(sys.executable).resolve().parent
    site = (donor / "Lib/site-packages").resolve()
    seeds = ["torch", "torchvision", "transformers", "Pillow", "numpy",
             "opencv-python-headless", "controlnet-aux", "rembg", "onnxruntime", "safetensors"]
    selected = {}
    pending = list(seeds)
    while pending:
        name = canonicalize_name(pending.pop())
        if name in selected:
            continue
        dist = metadata.distribution(name)
        selected[name] = dist
        for value in dist.requires or []:
            requirement = Requirement(value)
            if requirement.marker and not requirement.marker.evaluate({"extra": ""}):
                continue
            pending.append(requirement.name)
    # Only the base interpreter and standard library, not other installed apps.
    skip = {"site-packages", "__pycache__", "Scripts", "Doc", "Tools", "include", "libs"}
    shutil.copytree(donor, destination, ignore=lambda _directory, names: [name for name in names if name in skip or name.endswith((".pyc", ".pyo"))])
    target_site = destination / "Lib/site-packages"
    target_site.mkdir(parents=True)
    copied = set()
    for name, dist in sorted(selected.items()):
        if not dist.files:
            raise RuntimeError(f"Missing wheel RECORD for {name}")
        for item in dist.files:
            source = Path(dist.locate_file(item)).resolve()
            if not source.is_relative_to(site) or not source.is_file():
                continue
            relative = source.relative_to(site)
            if "__pycache__" in relative.parts or source.suffix in {".pyc", ".pyo"} or source.name == "direct_url.json":
                continue
            if source in copied:
                continue
            target = target_site / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            copied.add(source)
    # An explicit, relocatable distutils shim; unrelated .pth files are excluded.
    distutils = site / "distutils-precedence.pth"
    if distutils.is_file() and "setuptools" in selected:
        shutil.copy2(distutils, target_site / distutils.name)
    report = {
        "python": sys.version.split()[0], "architecture": "windows-x64",
        "packages": [{"name": name, "version": dist.version} for name, dist in sorted(selected.items())],
        "copiedDependencyFiles": len(copied),
    }
    (destination / "portable-packages.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"python": report["python"], "packages": len(selected), "files": len(copied)}), flush=True)


if __name__ == "__main__":
    main()
