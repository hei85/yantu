import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("asset library category sidebar", () => {
    test("keeps type, business and folder filters in a left-hand nav", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        const css = readFileSync(resolve(import.meta.dir, "../src/styles/workspace-product.css"), "utf8");
        expect(page).toContain('className="assets-collection-layout"');
        expect(page).toContain('aria-label="素材分类"');
        expect(page).toContain('title="素材类型"');
        expect(page).toContain('title="业务分类"');
        expect(page).toContain("我的分类");
        expect(page).not.toContain("全部自定义分类");
        expect(css).toMatch(/\.assets-collection-layout\s*\{[^}]*grid-template-columns:\s*220px minmax\(0, 1fr\)/s);
    });
});
