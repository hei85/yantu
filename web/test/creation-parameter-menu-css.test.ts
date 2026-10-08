import { describe, expect, test } from "bun:test";

async function creationCss() {
    return Bun.file(new URL("../src/pages/create/creation-product.css", import.meta.url)).text();
}

function section(source: string, start: string, end: string) {
    const from = source.indexOf(start);
    expect(from).toBeGreaterThan(-1);
    const to = source.indexOf(end, from);
    expect(to).toBeGreaterThan(from);
    return source.slice(from, to);
}

describe("creation parameter menu selected state", () => {
    test("高宽比选中态不依赖工作区令牌，弹层脱域时不会退化成白块", async () => {
        const source = await creationCss();
        const pressed = section(source, '.creation-parameter-menu .image-size-auto[aria-pressed="true"] {', "/* 图片质量");

        // 旧写法在弹层拿不到 --user-* 时整条声明失效，选中格子会变成白块。
        expect(pressed).not.toContain("var(--user-control-pressed)");
        expect(pressed).toContain("rgba(127, 127, 127, .18)");
        expect(pressed).toContain("background: color-mix(in srgb, currentColor 14%, transparent)");
        expect(pressed).toContain("box-shadow: inset 0 0 0 2px currentColor");
    });

    test("选中的比例缩略图用 currentColor 实心填充", async () => {
        const source = await creationCss();
        const icon = section(source, 'button[aria-pressed="true"] .image-size-ratio-icon', "/* 图片质量");

        expect(icon).toContain("background: currentColor !important");
        expect(icon).toContain("opacity: 1 !important");
        expect(icon).not.toContain("var(--user-ink)");
    });

    test("清晰度/质量/数量选中格同样使用 currentColor", async () => {
        const source = await creationCss();
        const grid = section(source, ".creation-choice-grid button[aria-pressed=\"true\"] {", "html:not(.dark)");

        expect(grid).not.toContain("var(--user-control-pressed)");
        expect(grid).toContain("box-shadow: inset 0 0 0 2px currentColor");
    });
});
