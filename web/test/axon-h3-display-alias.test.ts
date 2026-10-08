import { expect, test } from "bun:test";
import { isHeihanAxonH3Video } from "../src/lib/model-protocols";

test("Axon H3 display aliases use the same provider-scoped adapter as workflow IDs", () => {
    for (const name of ["MiniMax H3-1", "MiniMax-H3", "minimax_h3_z0902"]) {
        expect(isHeihanAxonH3Video("https://zh.heihan.dpdns.org/v1", name)).toBe(true);
        expect(isHeihanAxonH3Video("https://other-relay.example/v1", name)).toBe(false);
    }
    expect(isHeihanAxonH3Video("https://zh.heihan.dpdns.org/v1", "unrelated-video-model")).toBe(false);
});
