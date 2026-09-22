import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    OFFICIAL_APPLICATION_PLUGIN_IDS,
    isOfficialApplicationPluginId,
} from "../src/lib/plugins/official-applications";

describe("official application plugin classification", () => {
    test("covers every built-in application plugin, including editor and art critique", () => {
        // Regression: the admin plugin page kept its own list and missed these
        // two, so both rendered as disabled system protocols.
        expect(isOfficialApplicationPluginId("editor-shell")).toBe(true);
        expect(isOfficialApplicationPluginId("ai-art-critique")).toBe(true);
        expect(isOfficialApplicationPluginId("prompt-optimizer")).toBe(true);
        expect(isOfficialApplicationPluginId("eagle-asset-connector")).toBe(true);
        expect(isOfficialApplicationPluginId("runninghub-workflow-provider")).toBe(true);
    });

    test("does not treat uploaded or unknown plugins as official applications", () => {
        expect(isOfficialApplicationPluginId("some-uploaded-plugin")).toBe(false);
        expect(isOfficialApplicationPluginId("")).toBe(false);
        expect(isOfficialApplicationPluginId("portrait-clearance")).toBe(false);
        expect(isOfficialApplicationPluginId("media-conversion")).toBe(false);
        expect(isOfficialApplicationPluginId("comfyui-workflow-provider")).toBe(false);
    });

    test("exposes a single de-duplicated id list", () => {
        const ids = [...OFFICIAL_APPLICATION_PLUGIN_IDS];
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.length).toBe(5);
    });

});
