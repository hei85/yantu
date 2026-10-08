import { expect, test } from "bun:test";

import { withMeasuredDurationMs } from "@/services/file-storage";

test("实测 WebM 时长覆盖容器探测返回的零值并保持毫秒精度", () => {
    expect(withMeasuredDurationMs({ width: 746, durationMs: 0 }, 613)).toEqual({ width: 746, durationMs: 613 });
});

test("无效或非正实测时长不会被当成资源元数据", () => {
    const metadata = { durationMs: 0 };
    expect(withMeasuredDurationMs(metadata, 0)).toBe(metadata);
    expect(withMeasuredDurationMs(metadata, Number.NaN)).toBe(metadata);
});
