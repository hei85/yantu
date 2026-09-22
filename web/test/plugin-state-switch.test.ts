import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("plugin state switches", () => {
    test("uses a page-scoped green and neutral switch palette", () => {
        const styles = readFileSync(resolve(import.meta.dir, "../src/styles/globals.css"), "utf8");

        expect(styles).toContain("--plugin-switch-checked-bg: var(--control-switch-checked-bg);");
        expect(styles).toContain("--plugin-switch-off-bg: var(--control-switch-off-bg);");
        expect(styles).toContain(':where([data-slot="switch"].plugin-state-switch[data-state="on"])');
        expect(styles).toContain(':where([data-slot="switch"].plugin-state-switch[data-state="off"])');
    });

    test("shows explicit state text on the plugin page", () => {
        const userPage = readFileSync(resolve(import.meta.dir, "../src/pages/plugins/index.tsx"), "utf8");

        expect(userPage).toContain('className="plugin-state-switch"');
        expect(userPage).toContain('enabled ? "已启用" : "已停用"');
    });
});
