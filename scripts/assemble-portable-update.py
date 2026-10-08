# SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
"""Overlay a manifest-checked app update on an existing clean release ZIP."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import zipfile


def digest(file: Path) -> str:
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def replaceable(name: str) -> bool:
    return name.startswith("web/dist/") or name in {
        "backend/server.exe", "VERSION", "README.md", "快速开始.md", "使用说明.md",
    }


def records(manifest: dict) -> dict:
    result = {}
    for record in manifest["files"]:
        name = record["path"]
        parts = PurePosixPath(name).parts
        if not parts or name.startswith("/") or "\\" in name or ".." in parts or ".local" in parts or name in result:
            raise ValueError("Invalid or duplicate manifest path")
        if parts[0] == "canvas-agent-config" and name != "canvas-agent-config/.keep":
            raise ValueError("Private configuration in manifest")
        result[name] = record
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--patch", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-source-commit", required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("Refusing to overwrite an existing release")
    with zipfile.ZipFile(args.patch) as patch, zipfile.ZipFile(args.base) as base:
        meta = json.loads(patch.read("release-update.json"))
        manifest = json.loads(patch.read("portable-manifest.json"))
        if digest(args.base) != meta["baseSha256"]:
            raise SystemExit("Base release digest does not match")
        if manifest["sourceCommit"] != args.expected_source_commit:
            raise SystemExit("Compiled source provenance does not match checkout")
        if manifest["modelProvider"] != "Axon" or manifest["modelBaseUrl"] != "https://zh.heihan.dpdns.org/v1" or manifest["privateConfigurationIncluded"] is not False:
            raise SystemExit("Distribution or privacy policy changed")
        version = manifest["version"]
        if not re.fullmatch(r"v[0-9A-Za-z.-]+", version) or not re.fullmatch(r"v[0-9A-Za-z.-]+", meta["baseVersion"]):
            raise SystemExit("Invalid release version")
        prefix = "Yantu-" + version + "/"
        old_prefix = "Yantu-" + meta["baseVersion"] + "/"
        old = records(json.loads(base.read(old_prefix + "portable-manifest.json")))
        current = records(manifest)
        for name in old.keys() | current.keys():
            if old.get(name) != current.get(name) and not replaceable(name):
                raise SystemExit("Unexpected runtime change: " + name)
        changed = {name for name in current if old.get(name) != current[name]}
        expected = changed | {"portable-manifest.json", "release-update.json", "应用修复说明.txt"}
        if len(patch.namelist()) != len(set(patch.namelist())) or set(patch.namelist()) != expected:
            raise SystemExit("Patch includes missing or unlisted files")
        if set(base.namelist()) != {old_prefix + name for name in old} | {old_prefix + "portable-manifest.json"}:
            raise SystemExit("Base ZIP includes unlisted content")
        with zipfile.ZipFile(args.output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as output:
            for index, (name, record) in enumerate(sorted(current.items())):
                source, key = (patch, name) if name in changed else (base, old_prefix + name)
                checksum = hashlib.sha256()
                size = 0
                with source.open(key) as reader, output.open(prefix + name, "w", force_zip64=True) as writer:
                    while block := reader.read(1024 * 1024):
                        checksum.update(block)
                        size += len(block)
                        writer.write(block)
                if size != record["bytes"] or checksum.hexdigest() != record["sha256"]:
                    raise SystemExit("File does not match manifest: " + name)
                if index % 5000 == 0:
                    print(json.dumps({"assembledFiles": index}), flush=True)
            output.writestr(prefix + "portable-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    report = {"asset": args.output.name, "bytes": args.output.stat().st_size,
              "sha256": digest(args.output), "version": version, "sourceCommit": manifest["sourceCommit"],
              "files": len(current) + 1, "allFilesMatchManifest": True,
              "privateRuntimeStateIncluded": False, "unchangedRuntimesPreserved": True}
    args.output.with_suffix(".json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
