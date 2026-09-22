import { describe, expect, test } from "bun:test";

import { applySkinTheme, DEFAULT_CLASSIC_SKIN, duplicateSkinDefinition, getSkinAntOverrides, normalizeSkinDefinition, skinSwatches, SKIN_COLOR_GROUPS, SKIN_COMPONENT_NUMBER_FIELDS } from "../src/lib/skin-themes";
import { normalizePublicAppearance } from "../src/stores/use-appearance-store";

describe("site appearance and editable skin library", () => {
    test("classic preserves foundation tokens and applies only primary button fills", () => {
        expect(DEFAULT_CLASSIC_SKIN.locked).toBe(true);
        expect(getSkinAntOverrides(DEFAULT_CLASSIC_SKIN, "light")).toEqual({});
        expect(getSkinAntOverrides(DEFAULT_CLASSIC_SKIN, "dark")).toEqual({});

        const removed: string[] = [];
        const assigned = new Map<string, string>();
        const target = {
            documentElement: {
                dataset: {} as Record<string, string>,
                style: {
                    removeProperty: (key: string) => removed.push(key),
                    setProperty: (key: string, value: string) => assigned.set(key, value),
                },
            },
        } as unknown as Document;
        applySkinTheme(DEFAULT_CLASSIC_SKIN, "light", target);
        expect(removed.length).toBeGreaterThan(60);
        expect(assigned.size).toBe(4);
        expect(assigned.get("--button-primary-bg")).toBe("linear-gradient(115deg, #6554df, #386fbc)");
        expect(assigned.has("--background")).toBe(false);
        expect(target.documentElement.dataset.skin).toBe("classic");
    });

    test("duplicating classic materializes a complete editable theme", () => {
        const copy = duplicateSkinDefinition(DEFAULT_CLASSIC_SKIN, ["classic"], "我的主题");
        expect(copy.id.startsWith("custom-")).toBe(true);
        expect(copy.name).toBe("我的主题");
        expect(copy.locked).toBe(false);
        expect(copy.tokens).not.toBe(DEFAULT_CLASSIC_SKIN.tokens);
        expect(copy.tokens.light).not.toBe(DEFAULT_CLASSIC_SKIN.tokens.light);
        expect(Object.keys(copy.tokens.light)).toHaveLength(50);
        expect(SKIN_COLOR_GROUPS.flatMap((group) => group.fields)).toHaveLength(50);
        expect(SKIN_COMPONENT_NUMBER_FIELDS).toHaveLength(16);
    });

    test("custom themes map semantic colors and component styles into runtime variables", () => {
        const custom = duplicateSkinDefinition(DEFAULT_CLASSIC_SKIN, ["classic"]);
        custom.tokens.light.primary = "#123456";
        custom.tokens.light.switchChecked = "#17864b";
        custom.tokens.light.switchUnchecked = "#a3a3a3";
        custom.tokens.light.danger = "#c0262d";
        custom.tokens.light.dangerHover = "#9f1f25";
        custom.tokens.light.dangerActive = "#7f1d1d";
        custom.tokens.light.dangerForeground = "#ffffff";
        custom.tokens.light.iconActive = "#abcdef";
        custom.tokens.components.buttonRadius = 14;
        custom.tokens.components.motionNormal = 260;
        const assigned = new Map<string, string>();
        const target = {
            documentElement: {
                dataset: {} as Record<string, string>,
                style: { removeProperty: () => undefined, setProperty: (key: string, value: string) => assigned.set(key, value) },
            },
        } as unknown as Document;

        applySkinTheme(custom, "light", target);
        expect(assigned.get("--btn-solid-bg")).toBe("#123456");
        expect(assigned.get("--control-switch-checked-bg")).toBe("#17864b");
        expect(assigned.get("--control-switch-off-bg")).toBe("#a3a3a3");
        expect(assigned.get("--destructive")).toBe("#c0262d");
        expect(assigned.get("--destructive-hover")).toBe("#9f1f25");
        expect(assigned.get("--icon-active")).toBe("#abcdef");
        expect(assigned.get("--button-radius")).toBe("14px");
        expect(assigned.get("--motion-state")).toBe("260ms");
        expect(getSkinAntOverrides(custom, "light")).toMatchObject({ primary: "#123456", switchChecked: "#17864b", danger: "#c0262d", dangerHover: "#9f1f25", buttonRadius: 14, motionNormal: 260 });
    });

    test("legacy custom themes backfill new switch and destructive interaction colors", () => {
        const legacy = duplicateSkinDefinition(DEFAULT_CLASSIC_SKIN, ["classic"]) as SkinFixture;
        legacy.tokens.light.primary = "#123456";
        legacy.tokens.light.primaryHover = "#234567";
        legacy.tokens.light.danger = "#c0262d";
        delete legacy.tokens.light.switchChecked;
        delete legacy.tokens.light.switchCheckedHover;
        delete legacy.tokens.light.dangerHover;
        delete legacy.tokens.light.dangerActive;
        const normalized = normalizeSkinDefinition(legacy);
        expect(normalized.tokens.light.switchChecked).toBe("#123456");
        expect(normalized.tokens.light.switchCheckedHover).toBe("#234567");
        expect(normalized.tokens.light.dangerHover).toBe("#c0262d");
        expect(normalized.tokens.light.dangerActive).toBe("#c0262d");
    });

    test("theme-card swatches expose every real unique color in frequency order", () => {
        const swatches = skinSwatches(DEFAULT_CLASSIC_SKIN);
        const allColors = [...Object.values(DEFAULT_CLASSIC_SKIN.tokens.light), ...Object.values(DEFAULT_CLASSIC_SKIN.tokens.dark)];
        expect(swatches[0]).toBe(DEFAULT_CLASSIC_SKIN.tokens.light.canvas);
        expect(swatches[1]).toBe(DEFAULT_CLASSIC_SKIN.tokens.dark.canvas);
        expect(new Set(swatches)).toEqual(new Set(allColors));
    });

    test("unsafe or incomplete public themes fall back to classic", () => {
        const invalid = normalizeSkinDefinition({ ...DEFAULT_CLASSIC_SKIN, id: "bad id", tokens: { ...DEFAULT_CLASSIC_SKIN.tokens, light: { ...DEFAULT_CLASSIC_SKIN.tokens.light, primary: "red;url(x)" } } });
        expect(invalid.id).toBe("classic");
        expect(invalid.tokens.light.primary).toBe(DEFAULT_CLASSIC_SKIN.tokens.light.primary);
    });

    test("custom site metadata, footer, filing, and active skin survive normalization", () => {
        const activeSkin = duplicateSkinDefinition(DEFAULT_CLASSIC_SKIN, ["classic"], "暖调测试");
        const appearance = normalizePublicAppearance({
            brandName: "HIMA Studio",
            brandSlug: "hima-studio",
            skinId: activeSkin.id,
            activeSkin,
            seoTitle: "HIMA Studio - AI 影视工作台",
            seoDescription: "面向 AI 影视与短剧生产的一体化创作工作台。",
            seoKeywords: "AI 影视,短剧,画布",
            footerCopyright: "© 2026 HIMA Studio. All rights reserved.",
            icpFilingEnabled: true,
            icpFilingNumber: "蜀ICP备2026000000号-1",
        });

        expect(appearance).toMatchObject({
            brandName: "HIMA Studio",
            brandSlug: "hima-studio",
            skinId: activeSkin.id,
            seoTitle: "HIMA Studio - AI 影视工作台",
            seoKeywords: "AI 影视,短剧,画布",
            footerCopyright: "© 2026 HIMA Studio. All rights reserved.",
            icpFilingEnabled: true,
            icpFilingNumber: "蜀ICP备2026000000号-1",
        });
        expect(appearance.activeSkin.name).toBe("暖调测试");
    });

});

type SkinFixture = Omit<ReturnType<typeof duplicateSkinDefinition>, "tokens"> & {
    tokens: Omit<ReturnType<typeof duplicateSkinDefinition>["tokens"], "light"> & {
        light: Partial<ReturnType<typeof duplicateSkinDefinition>["tokens"]["light"]>;
    };
};
