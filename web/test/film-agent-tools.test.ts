import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { filmAgentToolNames, isFilmAgentReadTool, isFilmAgentToolName } from "@/services/api/film-agent-tools";

const readSource = (relative: string) => readFileSync(resolve(import.meta.dir, relative), "utf8");

describe("film agent tools", () => {
    test("exposes exactly the three pipeline tools", () => {
        expect(filmAgentToolNames).toEqual(["film_list_operations", "film_run_operation", "film_wait_task"]);
        expect(isFilmAgentToolName("film_run_operation")).toBe(true);
        expect(isFilmAgentToolName("canvas_get_state")).toBe(false);
        expect(isFilmAgentReadTool("film_list_operations")).toBe(true);
        expect(isFilmAgentReadTool("film_run_operation")).toBe(false);
    });

    test("reuses the existing prompt-template and generation-task services", () => {
        const source = readSource("../src/services/api/film-agent-tools.ts");

        // 只做编排：模板渲染、任务生命周期、产物解析全部走现有服务。
        expect(source).toContain("listAdminPromptTemplates()");
        expect(source).toContain("runBackendGenerationTask(");
        expect(source).toContain("submitBackendGenerationTask(");
        expect(source).toContain("queryGenerationTask(");
        expect(source).toContain("parseBackendGenerationResult(");
        // 页面同款调用协议：占位提示词 + promptTemplateOperation + 变量。
        expect(source).toContain("promptTemplateTaskPlaceholder(");
        expect(source).toContain("promptTemplateOperation: operation");
        expect(source).toContain("promptTemplateVariables: variables");
        // 幂等重试：同一镜头复用 clientOperationId。
        expect(source).toContain("clientOperationId: optionalString(rawInput.clientOperationId)");
        // 不允许在该模块里自己拼模板或直连供应商。
        expect(source).not.toContain("fetch(\"https://");
        expect(source).not.toContain("Authorization: Bearer");
    });

    test("runs film tools through the page bridge like project tools", () => {
        const bridge = readSource("../src/components/canvas/canvas-local-agent-bridge.tsx");

        expect(bridge).toContain("isFilmAgentToolName(payload.name)");
        expect(bridge).toContain("await runFilmAgentTool(payload.name, input2)");
        expect(bridge).toContain("snapshotRef.current.domainProjectId");
    });

    test("agent declares and routes the film tools", () => {
        const schemas = readSource("../../canvas-agent/src/schemas.ts");
        const session = readSource("../../canvas-agent/src/canvas-session.ts");
        const prompt = readSource("../../canvas-agent/src/config.ts");

        for (const name of filmAgentToolNames) expect(schemas).toContain(`"${name}"`);
        expect(schemas).toContain("film_run_operation: z.object({");
        expect(session).toContain('if (tool.startsWith("film_"))');
        expect(session).toContain("当前没有已连接的衍图页面");
        // 影视流水线规范必须进入 Agent 系统提示，Codex 才知道先发现能力再编排。
        expect(prompt).toContain("【影视流水线】");
        expect(prompt).toContain("film_list_operations");
        expect(prompt).toContain("project_create_or_update_shots");
        expect(prompt).toContain("clientOperationId");
    });

    test("runtime returns the real tool error message to the MCP client", () => {
        const security = readSource("../../canvas-agent/src/local-runtime-security.ts");
        const mcp = readSource("../../canvas-agent/src/mcp-server.ts");

        expect(security).toContain('code: "runtime_internal_error"');
        expect(security).toContain("error: error instanceof Error ? error.message : String(error || \"\")");
        expect(mcp).toContain("body.error");
    });
});
