import { expect, test } from "bun:test";

import { appearanceLogoURL, normalizePublicAppearance } from "../src/stores/use-appearance-store";

test("initial HTML stays brand neutral until the public appearance is resolved", async () => {
    const [html, mainSource] = await Promise.all([Bun.file(new URL("../index.html", import.meta.url)).text(), Bun.file(new URL("../src/main.tsx", import.meta.url)).text()]);

    expect(html).not.toContain("衍图");
    expect(html).toContain("<title>正在加载</title>");
    expect(mainSource.indexOf("bootstrapAppearance()")).toBeLessThan(mainSource.indexOf('import("./application")'));
});

test("appearance URLs reject executable and insecure remote schemes", () => {
    const appearance = normalizePublicAppearance({ logoConfigured: true, logoUrl: "javascript:alert(1)" });
    expect(appearance.logoUrl).toBe("/logo.svg");
});

test("appearance selects theme logos and falls back to the single configured logo", () => {
    const dual = normalizePublicAppearance({
        logoConfigured: true,
        darkLogoConfigured: true,
        logoUrl: "/api/public/appearance/assets/logo?v=dual",
        darkLogoUrl: "/api/public/appearance/assets/logo-dark?v=dual",
        logoFrameEnabled: false,
    });
    expect(appearanceLogoURL(dual, "light")).toContain("/logo?");
    expect(appearanceLogoURL(dual, "dark")).toContain("/logo-dark?");
    expect(dual.logoFrameEnabled).toBe(false);

    const single = normalizePublicAppearance({ logoConfigured: true, logoUrl: "/api/public/appearance/assets/logo?v=single" });
    expect(appearanceLogoURL(single, "light")).toBe(single.logoUrl);
    expect(appearanceLogoURL(single, "dark")).toBe(single.logoUrl);
    expect(single.logoFrameEnabled).toBe(true);
});
