// SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

test("published Runtime does not mount an external paid CLI provider", () => {
    const source = readFileSync(new URL("../src/local-runtime-host.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /import\s+\{\s*createDreaminaHttpModule/);
    assert.doesNotMatch(source, /createDreaminaHttpModule\s*\(/);
    assert.match(source, /createCanvasAgentHttpModule\(config\)/);
});

test("MCP launcher supports an explicit source root and verifies its version", () => {
    const source = readFileSync(new URL("../../plugins/yingce/scripts/start-mcp.mjs", import.meta.url), "utf8");
    assert.match(source, /process\.env\.CANVAS_PROJECT_ROOT/);
    assert.match(source, /versionMatches/);
    assert.match(source, /fs\.realpathSync\(selectedRoot\)/);
});
