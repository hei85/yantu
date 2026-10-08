import assert from "node:assert/strict";
import test from "node:test";

import "../../lib/canvas/node-registry/definitions/index.ts";
// @ts-expect-error -- Node 原生 TypeScript 测试运行器需要保留扩展名。
import { buildNodeGenerationContext } from "./canvas-node-generation.ts";
// @ts-expect-error -- Node 原生 TypeScript 测试运行器需要保留扩展名。
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../../types/canvas.ts";

function textNode(id: string, content: string): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Text,
        title: id,
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: { content, status: "success" },
    };
}

test("explicit text references include each label once and preserve multiple referenced texts", () => {
    const nodes = [textNode("text-a", "桥边夕阳"), textNode("text-b", "成年女性动漫人物")];
    const image: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "image", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: {} };
    const connections: CanvasConnection[] = nodes.map((node) => ({ id: `edge-${node.id}`, fromNodeId: node.id, toNodeId: image.id }));
    const context = buildNodeGenerationContext("image", [...nodes, image], connections, "@[node:text-a] @[node:text-b]", []);

    assert.equal(context.prompt, "【文本1】 【文本2】\n\n桥边夕阳\n\n成年女性动漫人物");
});
