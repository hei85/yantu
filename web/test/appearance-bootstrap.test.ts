import { expect, test } from "bun:test";

import { appearanceLogoURL, normalizePublicAppearance } from "../src/stores/use-appearance-store";

test("initial HTML stays brand neutral until the public appearance is resolved", async () => {
    const [html, mainSource] = await Promise.all([Bun.file(new URL("../index.html", import.meta.url)).text(), Bun.file(new URL("../src/main.tsx", import.meta.url)).text()]);

    expect(html).not.toContain("衍图");
    expect(html).toContain("<title>正在加载</title>");
    expect(mainSource.indexOf("bootstrapAppearance()")).toBeLessThan(mainSource.indexOf('import("./application")'));
});

test("a custom login video never falls back to the built-in poster", () => {
    const appearance = normalizePublicAppearance({
        brandName: "HIMA Studio",
        brandSlug: "hima-studio",
        authHeroTitle: "把灵感，\n变成可见的故事。",
        authHeroDescription: "从同一个创作空间持续推进。",
        authVideoConfigured: true,
        authVideoUrl: "/api/public/appearance/assets/video?v=next",
        authVideoPosterConfigured: false,
        authVideoPosterUrl: "",
    });

    expect(appearance.brandName).toBe("HIMA Studio");
    expect(appearance.brandSlug).toBe("hima-studio");
    expect(appearance.authHeroTitle).toBe("把灵感，\n变成可见的故事。");
    expect(appearance.authHeroDescription).toBe("从同一个创作空间持续推进。");
    expect(appearance.authVideoPosterUrl).toBe("");
    expect(appearance.authVideoAutoplay).toBe(true);
});

test("login video autoplay defaults on and can be disabled explicitly", () => {
    expect(normalizePublicAppearance({}).authVideoAutoplay).toBe(true);
    expect(normalizePublicAppearance({ authVideoAutoplay: false }).authVideoAutoplay).toBe(false);
});

test("appearance URLs reject executable and insecure remote schemes", () => {
    const appearance = normalizePublicAppearance({
        logoConfigured: true,
        logoUrl: "javascript:alert(1)",
        authVideoConfigured: true,
        authVideoUrl: "http://example.com/brand.mp4",
    });

    expect(appearance.logoUrl).toBe("/logo.svg");
    expect(appearance.authVideoUrl).not.toContain("example.com");
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

test("auth scene consumes resolved appearance instead of hardcoded media constants", async () => {
    const source = await Bun.file(new URL("../src/pages/auth/auth-scene.tsx", import.meta.url)).text();

    expect(source).toContain("appearance.authVideoUrl");
    expect(source).toContain("appearance.authVideoAutoplay");
    expect(source).toContain("appearance.authVideoPosterUrl || undefined");
    expect(source).toContain("appearance.brandName");
    expect(source).toContain("appearance.authHeroTitle");
    expect(source).toContain("appearance.authHeroDescription");
    expect(source).toContain('theme="dark"');
    expect(source).not.toContain("让一个故事，");
    expect(source).not.toContain("AUTH_VIDEO_URL");
    expect(source).not.toContain("AUTH_VIDEO_POSTER");
});
