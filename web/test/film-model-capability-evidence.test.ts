import { describe, expect, test } from "bun:test";

import { capabilityEvidenceFromConfig } from "../src/services/api/film-agent-tools";

describe("film model capability evidence", () => {
    test("把持久化的实测结论整理成 Agent 可读列表，并只保留最近 6 条", () => {
        const observed = Array.from({ length: 9 }, (_, index) => ({
            verdict: "unsupported",
            feature: "image_input",
            reason: `reason-${index}`,
            at: `2026-09-25T00:0${index}:00Z`,
        }));

        const evidence = capabilityEvidenceFromConfig({ observed });

        expect(evidence).toHaveLength(6);
        expect(evidence[0]?.reason).toBe("reason-3");
        expect(evidence[5]?.reason).toBe("reason-8");
        expect(evidence[0]?.feature).toBe("image_input");
    });

    test("没有实测证据时返回空数组，且过滤掉无效条目", () => {
        expect(capabilityEvidenceFromConfig(undefined)).toEqual([]);
        expect(capabilityEvidenceFromConfig({})).toEqual([]);
        expect(capabilityEvidenceFromConfig({ observed: "not-an-array" })).toEqual([]);
        expect(capabilityEvidenceFromConfig({
            observed: [null, 3, {}, { verdict: "supported", feature: "text_to_video", reason: "真实任务成功" }],
        })).toEqual([{ verdict: "supported", feature: "text_to_video", reason: "真实任务成功", at: "", source: "" }]);
    });
});
