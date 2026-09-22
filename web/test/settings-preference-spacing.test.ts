import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("settings page drops the page header copy and audio preference blocks", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/pages/settings/index.tsx"), "utf8");
    expect(source).not.toContain("创作偏好");
    expect(source).not.toContain("配置默认模型、生成参数和素材存储。");
    expect(source).not.toContain("音频默认值");
    expect(source).not.toContain("音频指令");
    expect(source).not.toContain("默认音频指令");
    expect(source).toContain("默认生图张数");
    expect(source).toContain("settings-preference-heading");
});
