import { expect, test } from "bun:test";
import { generationErrorMessage } from "../src/lib/generation-error";

test("model permission failure explains the next action", () => {
    expect(generationErrorMessage({ error: "模型服务鉴权失败，请检查 API Key 和模型权限", errorCode: "model_access_denied" }))
        .toBe("当前渠道的 API Key 无权使用所选模型。请在中转站开通该模型，或切换有权限的模型。");
});
