import { describe, expect, test } from "bun:test";

import { isConfigSection } from "../src/pages/settings/settings-sections";

describe("settings section registry", () => {
    test("keeps the system sections that were restored from the admin console", () => {
        for (const key of ["appearance", "storage", "interception", "runtime-policy", "system-update", "runninghub", "analytics", "logs"]) {
            expect(isConfigSection(key)).toBe(true);
        }
    });

    test("rejects unknown sections instead of silently rendering an empty pane", () => {
        expect(isConfigSection("not-a-section")).toBe(false);
        expect(isConfigSection(null)).toBe(false);
    });
});
