import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandLogoFrame } from "../src/components/brand/brand-logo";
import { DEFAULT_PUBLIC_APPEARANCE, useAppearanceStore } from "../src/stores/use-appearance-store";

afterEach(() => useAppearanceStore.getState().setAppearance(DEFAULT_PUBLIC_APPEARANCE));

test("the bundled fox logo renders even when no custom brand upload is configured", () => {
    useAppearanceStore.getState().setAppearance(DEFAULT_PUBLIC_APPEARANCE);
    const markup = renderToStaticMarkup(<BrandLogoFrame fallback={<span>old-infinity</span>} theme="light" />);
    expect(markup).toContain('src="/logo.svg"');
    expect(markup).not.toContain("old-infinity");
});
