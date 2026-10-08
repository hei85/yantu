// SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
import { describe, expect, test } from "bun:test";
import { AXON_BASE_URL, isAxonBaseUrl, isPublishedSystemChannel } from "../src/lib/distribution-policy";

describe("Axon release model boundary", () => {
    test("accepts only the fixed relay connection", () => {
        expect(isAxonBaseUrl(AXON_BASE_URL)).toBe(true);
        expect(isAxonBaseUrl("https://zh.heihan.dpdns.org/")).toBe(true);
        for (const url of ["https://api.openai.com/v1", "http://zh.heihan.dpdns.org/v1", "https://zh.heihan.dpdns.org.evil.example/v1", `${AXON_BASE_URL}?upstream=other`, `${AXON_BASE_URL}/proxy`, "https://user:pass@zh.heihan.dpdns.org/v1"]) expect(isAxonBaseUrl(url)).toBe(false);
    });
    test("restored local channels cannot enter the published picker", () => {
        expect(isPublishedSystemChannel({ scope: "user", baseUrl: AXON_BASE_URL })).toBe(false);
        expect(isPublishedSystemChannel({ scope: "system", baseUrl: "https://api.openai.com/v1" })).toBe(false);
        expect(isPublishedSystemChannel({ scope: "system", baseUrl: "/api/ai/system/CHANNEL_000001" })).toBe(true);
    });
});
