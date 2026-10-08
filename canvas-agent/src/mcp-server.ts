import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AGENT_PROMPT, loadConfig, type CanvasAgentConfig, VERSION } from "./config.js";
import { toolDescriptions, toolInputSchemas, toolNames, type ToolName } from "./schemas.js";

type CanvasAgentToolResponse = { ok?: boolean; result?: unknown; error?: string; code?: string; message?: string };

class CanvasAgentCallError extends Error {
    constructor(readonly details: {
        code: string;
        message: string;
        operationOutcome: "not_dispatched" | "unknown";
        nextAction: string;
        httpStatus?: number;
    }) {
        super(details.message);
    }
}

export async function startMcpServer() {
    const config = loadConfig(true);
    const server = new McpServer({ name: "canvas-agent", version: VERSION }, { instructions: AGENT_PROMPT });
    registerMcpTools(server, config);
    await server.connect(new StdioServerTransport());
}

export function registerMcpTools(server: McpServer, config: CanvasAgentConfig) {
    toolNames.forEach((name) => registerCanvasTool(server, config, name));
}

function registerCanvasTool(server: McpServer, config: CanvasAgentConfig, name: ToolName) {
    const schema = toolInputSchemas[name];
    server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (input: unknown) => {
        try {
            const result = await postCanvasAgentTool(config, name, schema.parse(input));
            return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            const details = error instanceof CanvasAgentCallError ? error.details : {
                code: "tool_call_failed",
                message: safeErrorMessage(error instanceof Error ? error.message : "工具调用失败"),
                operationOutcome: "unknown",
                nextAction: "先回读目标画布、原任务和资源核对执行结果；不要自动重发写入或收费生成。",
            };
            return {
                isError: true,
                content: [{ type: "text" as const, text: JSON.stringify({
                    ok: false,
                    tool: name,
                    runtimeOrigin: new URL(config.url).origin,
                    error: details,
                }, null, 2) }],
            };
        }
    });
}

async function postCanvasAgentTool(config: CanvasAgentConfig, name: ToolName, input: unknown) {
    let res: Response;
    try {
        res = await fetch(`${config.url}/api/tools`, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": config.token }, body: JSON.stringify({ name, input }) });
    } catch (error) {
        const cause = error instanceof Error ? error.cause as { code?: string } | undefined : undefined;
        const refused = cause?.code === "ECONNREFUSED" || cause?.code === "ENOTFOUND";
        throw new CanvasAgentCallError({
            code: refused ? "runtime_unreachable" : "runtime_transport_interrupted",
            message: refused ? "未连接到本地衍图 Runtime；请检查便携版控制服务是否启动。" : "与本地衍图 Runtime 的通信中断，未取得完整回执。",
            operationOutcome: refused ? "not_dispatched" : "unknown",
            nextAction: "恢复便携版控制服务后读取在线画布；已有生成先查询原任务/操作ID，不新建付费请求。",
        });
    }
    let body: CanvasAgentToolResponse;
    try {
        const value: unknown = await res.json();
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid response");
        body = value as CanvasAgentToolResponse;
    } catch {
        throw new CanvasAgentCallError({
            code: "runtime_invalid_response",
            message: "本地 Runtime 未返回可识别的工具回执。",
            operationOutcome: "unknown",
            nextAction: "核对 Runtime 版本与运行日志；写入可能已经执行，先回读而非重发。",
            httpStatus: res.status,
        });
    }
    if (!res.ok || body.ok !== true) {
        const authRejected = res.status === 401 || res.status === 403;
        throw new CanvasAgentCallError({
            code: typeof body.code === "string" ? body.code : authRejected ? "runtime_authorization_failed" : "runtime_tool_rejected",
            message: safeErrorMessage(typeof body.error === "string" && body.error
                ? body.error
                : typeof body.message === "string" && body.message
                ? body.message
                : `本地 Runtime 拒绝工具请求（HTTP ${res.status}）`),
            operationOutcome: authRejected ? "not_dispatched" : "unknown",
            nextAction: authRejected
                ? "核对本包 MCP 运行时指针与本地授权配置，不绕过授权检查。"
                : "根据错误读取最新状态并纠正输入；超时先核对原任务/资源，不盲目重发。",
            httpStatus: res.status,
        });
    }
    return body.result;
}

function safeErrorMessage(message: string) {
    return message
        .replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer [redacted]")
        .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted-key]")
        .replace(/((?:api[_-]?key|authorization|cookie|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*)["']?[^\s,"'}]+/gi, "$1[redacted]")
        .slice(0, 2400);
}
