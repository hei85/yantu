import { expect, test } from "bun:test";
import { storyboardDisplayAssets } from "../src/lib/canvas/storyboard-display-assets";

test("each shot displays its own opening frame before shared references", () => {
    const bindings = [{ nodeId: "cat", role: "character" as const }];
    expect(storyboardDisplayAssets(bindings, "shot-1")[0].nodeId).toBe("shot-1");
    expect(storyboardDisplayAssets(bindings, "shot-2")[0].nodeId).toBe("shot-2");
});
test("one picture with scene and prop roles displays once and retains both roles", () => {
    const result = storyboardDisplayAssets([{ nodeId: "alley", role: "environment" }, { nodeId: "alley", role: "prop" }], "opening");
    expect(result).toHaveLength(2);
    expect(result[1].roles).toEqual(["environment", "prop"]);
});
test("opening frame also bound as a reference is not duplicated", () => {
    expect(storyboardDisplayAssets([{ nodeId: "opening", role: "environment" }], "opening")).toEqual([{ nodeId: "opening", firstFrame: true, roles: ["environment"] }]);
});
