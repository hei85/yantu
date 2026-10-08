# SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
"""Inspect files selected by Git without printing credentials or file contents."""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
selected = subprocess.check_output(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    cwd=ROOT,
).decode("utf-8").split("\0")
patterns = {
    "private-key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "github-token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b"),
    "provider-key": re.compile(r"\bsk-[A-Za-z0-9_-]{24,}\b"),
    "aws-access-key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "maintainer-machine-path": re.compile(r"(?i)(?:D:[/\\]HU[/\\]|C:[/\\]Users[/\\]q1775[/\\])"),
}
private_segments = {"node_modules", ".local", "canvas-agent-config", "workspace", "backups", "python-runtime"}
private_extensions = {".db", ".sqlite", ".sqlite3", ".pem", ".key", ".pfx", ".log", ".exe"}
findings: list[dict] = []
large: list[dict] = []
total = 0
for name in sorted(set(selected)):
    if not name:
        continue
    relative = Path(name)
    file = ROOT / relative
    if not file.is_file():
        continue
    total += 1
    skill_template = name.startswith("plugins/yingce/skills/higgsfield-ai-prompt-skill/workspace/") and relative.name in {"README.md", ".gitignore"}
    if (set(relative.parts) & private_segments and not skill_template) or relative.suffix.lower() in private_extensions or (relative.name.startswith(".env") and relative.name != ".env.example"):
        findings.append({"file": name, "kind": "private-runtime-file"})
    size = file.stat().st_size
    if size > 10 * 1024 * 1024:
        large.append({"file": name, "bytes": size})
    if size > 100 * 1024 * 1024:
        findings.append({"file": name, "kind": "github-oversize"})
    data = file.read_bytes()
    if b"\0" in data[:8192]:
        continue
    try:
        content = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        continue
    fixture = "/test/" in "/" + name or name.endswith("_test.go")
    for kind, pattern in patterns.items():
        for match in pattern.finditer(content):
            value = match.group()
            if fixture and kind in {"provider-key", "aws-access-key", "private-key"}:
                continue
            if kind == "provider-key" and re.match(r"sk-(?:test|example|dummy|fake|placeholder)", value, re.I):
                continue
            findings.append({"file": name, "kind": kind, "line": content.count("\n", 0, match.start()) + 1})
report = {"files": total, "findings": findings, "largeFiles": large, "scope": "Git-selected working tree, not repository history"}
print(json.dumps(report, ensure_ascii=False, indent=2))
raise SystemExit(1 if findings else 0)
