import { describe, expect, test } from "bun:test";

import { configSections, isConfigSection } from "../src/pages/settings/settings-sections";

describe("settings section registry", () => {
    test("keeps only the retained system sections", () => {
        for (const key of ["prompt-templates", "drawing-engine", "third-party"]) {
            expect(isConfigSection(key)).toBe(true);
        }
        for (const key of ["features", "storage", "interception", "runtime-policy", "system-update", "runninghub", "analytics", "logs", "appearance"]) {
            expect(isConfigSection(key)).toBe(false);
        }
        expect(configSections.filter((section) => section.group === "系统").map((section) => section.key)).toEqual(["prompt-templates", "drawing-engine", "third-party"]);
    });

    test("rejects unknown sections instead of silently rendering an empty pane", () => {
        expect(isConfigSection("not-a-section")).toBe(false);
        expect(isConfigSection(null)).toBe(false);
    });
});
