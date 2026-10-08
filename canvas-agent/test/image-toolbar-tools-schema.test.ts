import { describe, expect, test } from "bun:test";
import { toolInputSchemas, toolNames, toolDescriptions } from "../src/schemas";

const context = { expectedCanvasId: "fixture", expectedRevision: 1, expectedStateHash: "fixture-hash" };
const rectangle = { x: 0.1, y: 0.1, width: 0.3, height: 0.3 };
const writeCalls = {
    canvas_edit_image: { nodeId: "image", action: "mask", prompt: "修正手指", regions: [rectangle], clientOperationId: "fixture-edit-1" },
    canvas_analyze_image: { nodeId: "image", analysis: "reverse_prompt", clientOperationId: "fixture-analyze-1" },
    canvas_annotate_image: { nodeId: "image", marks: [{ type: "rectangle", ...rectangle }] },
    canvas_decompose_image: { nodeId: "image", layers: [{ label: "主体", prompt: "提取人物" }, { label: "背景", prompt: "保留已有背景" }], clientOperationId: "fixture-layers-1" },
    canvas_create_panorama_viewer: { nodeId: "image", projection: "spherical" },
    canvas_save_node_asset: { nodeId: "image" },
    canvas_image_node_action: { nodeId: "image", action: "preview" },
} as const;

describe("image toolbar MCP contracts", () => {
    for (const [name, input] of Object.entries(writeCalls)) {
        test(`${name} is registered, guarded and strict`, () => {
            const key = name as keyof typeof writeCalls;
            expect(toolNames.includes(key)).toBe(true);
            expect(toolDescriptions[key].length).toBeGreaterThan(20);
            expect(toolInputSchemas[key].safeParse({ ...context, ...input }).success).toBe(true);
            expect(toolInputSchemas[key].safeParse(input).success).toBe(false);
            expect(toolInputSchemas[key].safeParse({ ...context, ...input, unknownField: true }).success).toBe(false);
        });
    }
    test("preflight is read only and rejects out of source regions", () => {
        const schema = toolInputSchemas.canvas_preflight_image_edit;
        expect(schema.safeParse({ canvasId: "fixture", nodeId: "image", action: "mask", prompt: "修正", regions: [rectangle] }).success).toBe(true);
        expect(schema.safeParse({ nodeId: "image", action: "mask", regions: [{ ...rectangle, x: 0.9 }] }).success).toBe(false);
    });
    test("model IDs and operation IDs are bounded; layers are not a merged single image", () => {
        expect(toolInputSchemas.canvas_edit_image.safeParse({ ...context, nodeId: "image", action: "not-an-action", clientOperationId: "x" }).success).toBe(false);
        expect(toolInputSchemas.canvas_edit_image.safeParse({ ...context, nodeId: "image", action: "angle", clientOperationId: "x", angle: { horizontalAngle: 0, pitchAngle: 0, cameraDistance: -1, wideAngle: false } }).success).toBe(false);
        expect(toolInputSchemas.canvas_decompose_image.safeParse({ ...context, ...writeCalls.canvas_decompose_image, layers: [{ label: "one", prompt: "one" }] }).success).toBe(false);
        expect(toolInputSchemas.canvas_decompose_image.safeParse({ ...context, ...writeCalls.canvas_decompose_image, layers: Array(7).fill({ label: "one", prompt: "one" }) }).success).toBe(false);
    });
});
