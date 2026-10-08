import type { Request, RequestHandler, Response } from "express";

import { CanvasSession } from "../canvas-session.js";
import type { LocalRuntimeConfig } from "../config.js";
import type { LocalRuntimeModule, LocalRuntimeProtectedRoute } from "../local-runtime.js";

export type CanvasAgentSession = Pick<
    CanvasSession,
    "health" | "openEvents" | "updateState" | "resolveResult" | "streamLocalUpload" | "emitAll" | "callTool" | "closeRuntimeSession" | "dispose"
>;

export function createCanvasAgentHttpModule(
    config: LocalRuntimeConfig,
    session: CanvasAgentSession = new CanvasSession(),
): LocalRuntimeModule {
    const routes: LocalRuntimeProtectedRoute[] = [
        canvasRoute("GET", "/events", (req, res) => {
            session.openEvents(
                new URL(req.originalUrl || req.url, config.url),
                res,
                runtimeSessionId(res),
            );
        }, { queryKeys: ["clientId"], lastEventId: true }),
        canvasRoute("POST", "/canvas/state", (req, res) => {
            const result = session.updateState(jsonBody(req), queryValue(req, "clientId") || undefined);
            if (!result) {
                res.json({ ok: true });
                return;
            }
            if (result && !result.accepted) {
                res.status(409).json({ ok: false, ...result });
                return;
            }
            res.json({ ok: true, ...result });
        }, { queryKeys: ["clientId"] }),
        canvasRoute("POST", "/canvas/result", (req, res) => {
            const clientId = queryValue(req, "clientId");
            if (!clientId) {
                res.status(400).json({ ok: false, error: "clientId is required" });
                return;
            }
            const resolved = session.resolveResult(jsonBody(req) as { requestId?: string; error?: string; result?: unknown }, clientId);
            if (!resolved) {
                res.status(409).json({ ok: false, error: "unknown request or clientId mismatch" });
                return;
            }
            res.json({ ok: true });
        }, { queryKeys: ["clientId"] }),
        canvasRoute("GET", "/canvas/uploads/:uploadId", (req, res) => {
            session.streamLocalUpload(String(req.params.uploadId || ""), queryValue(req, "clientId"), runtimeSessionId(res) || "", res);
        }, { queryKeys: ["clientId"] }),
        canvasRoute("POST", "/api/tools", async (req, res) => {
            const body = jsonRecord(req);
            res.json({ ok: true, result: await session.callTool(body.name, body.input || {}) });
        }),
        ...removedAgentRoutes(),
    ];

    return {
        descriptor: {
            id: "canvas-agent",
            displayName: "Canvas Agent",
            apiVersion: 1,
            scopes: ["canvas:connect"],
        },
        routes,
        onRuntimeSessionRevoked: (sessionId) => session.closeRuntimeSession(sessionId),
        publicHealth: () => {
            const { ok: _ok, ...health } = session.health();
            return health;
        },
        dispose: () => session.dispose(),
    };
}

const REMOVED_AGENT_ROUTES: ReadonlyArray<{ method: "GET" | "POST"; path: string }> = [
    { method: "GET", path: "/agent/codex/workspace" },
    { method: "GET", path: "/agent/codex/threads" },
    { method: "POST", path: "/agent/codex/threads/new" },
    { method: "GET", path: "/agent/codex/threads/:threadId" },
    { method: "POST", path: "/agent/codex/threads/:threadId/resume" },
    { method: "POST", path: "/agent/codex/threads/:threadId/delete" },
    { method: "POST", path: "/agent/codex/turn" },
    { method: "POST", path: "/agent/claude/turn" },
];

function removedAgentRoutes(): LocalRuntimeProtectedRoute[] {
    return REMOVED_AGENT_ROUTES.map(({ method, path }) => canvasRoute(method, path, (_req, res) => {
        res.status(410).json({
            ok: false,
            code: "agent_control_removed",
            message: "该内置 Agent 控制入口已移除；请通过外部 Codex 的衍图插件与 yingce MCP 执行操作。",
        });
    }));
}

function runtimeSessionId(res: Response) {
    const value = (res.locals.runtimeSession as { sessionId?: unknown } | undefined)?.sessionId;
    return typeof value === "string" && value ? value : undefined;
}

function canvasRoute(
    method: "GET" | "POST",
    path: string,
    handler: (req: Request, res: Response) => void | Promise<void>,
    options: { queryKeys?: readonly string[]; lastEventId?: boolean } = {},
): LocalRuntimeProtectedRoute {
    return {
        method,
        path,
        scope: "canvas:connect",
        handler: route(handler),
        legacy: true,
        ...options,
    };
}

function route(handler: (req: Request, res: Response) => void | Promise<void>): RequestHandler {
    return (req, res, next) => {
        void Promise.resolve(handler(req, res)).catch(next);
    };
}

function jsonBody(req: Request) {
    if (!Buffer.isBuffer(req.body)) throw new Error("Canvas request body is invalid");
    return JSON.parse(req.body.toString("utf8")) as unknown;
}

function jsonRecord(req: Request) {
    const value = jsonBody(req);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Canvas request body is invalid");
    return value as Record<string, unknown>;
}

function queryValue(req: Request, key: string) {
    const value = req.query[key];
    return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}
