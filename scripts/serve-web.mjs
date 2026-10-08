// 便携版网页服务：把 web/dist 静态托管在 3000，并把 /api 转发到本机后端 8080。
// 只用 Node 内置模块，不需要任何依赖。
import { createServer, request as httpRequest } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const distDir = path.join(root, "web", "dist");
const port = Number(process.env.PORTABLE_WEB_PORT || 3000);
const apiTarget = process.env.PORTABLE_API_TARGET || "http://127.0.0.1:8080";
const target = new URL(apiTarget);
const taskDbPath = path.join(process.env.CANVAS_BACKEND_DATA_DIR || path.join(root, ".local", "app-data"), "open_ai_canvas.db");
const exposedTaskErrorCodes = new Set(["sensitive_words_detected", "model_not_found", "model_missing", "model_access_denied"]);
let taskErrorStatement;

function localTaskErrorCode(taskId) {
    try {
        if (!taskErrorStatement) {
            if (!existsSync(taskDbPath)) return "";
            const db = new DatabaseSync(taskDbPath, { readOnly: true });
            taskErrorStatement = db.prepare("SELECT error_code, error FROM api_call_logs WHERE task_id = ? AND status = 'failed' ORDER BY created_at DESC, id DESC LIMIT 1");
        }
        const diagnostic = taskErrorStatement.get(taskId);
        const code = diagnostic?.error_code;
        if (exposedTaskErrorCodes.has(code)) return code;
        return /this token has no access to model/i.test(String(diagnostic?.error || "")) ? "model_access_denied" : "";
    } catch {
        return "";
    }
}

function serveLocalTaskError(res, taskId) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ code: 0, data: { errorCode: localTaskErrorCode(taskId) }, msg: "" }));
}

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".tflite": "application/octet-stream",
    ".bin": "application/octet-stream",
};

function failProxyResponse(res) {
    if (res.destroyed || res.writableEnded) return;
    // The backend may disconnect after headers or a partial media response.
    // Closing that response must not throw and terminate the static server.
    if (res.headersSent) {
        res.destroy();
        return;
    }
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("后端（8080）没有响应，请确认 server.exe 已启动。");
}

function proxyApi(req, res) {
    const upstream = httpRequest(
        {
            hostname: target.hostname,
            port: target.port || 80,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, host: `${target.hostname}:${target.port || 80}` },
        },
        (upstreamRes) => {
            if (res.destroyed || res.writableEnded) {
                upstreamRes.destroy();
                return;
            }
            upstreamRes.on("error", () => failProxyResponse(res));
            res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
            upstreamRes.pipe(res);
        },
    );
    upstream.on("error", () => failProxyResponse(res));
    req.pipe(upstream);
}

function sendFile(res, filePath) {
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    createReadStream(filePath).pipe(res);
}

const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const taskErrorMatch = req.method === "GET" && url.pathname.match(/^\/api\/portable\/task-errors\/([A-Za-z0-9_-]{8,100})$/);
    if (taskErrorMatch) {
        serveLocalTaskError(res, taskErrorMatch[1]);
        return;
    }
    if (url.pathname.startsWith("/api")) {
        proxyApi(req, res);
        return;
    }
    const decoded = decodeURIComponent(url.pathname);
    const candidate = path.join(distDir, decoded);
    if (candidate.startsWith(distDir) && existsSync(candidate) && statSync(candidate).isFile()) {
        sendFile(res, candidate);
        return;
    }
    const indexFile = path.join(distDir, "index.html");
    if (existsSync(indexFile)) {
        sendFile(res, indexFile);
        return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("找不到 web/dist，请确认便携包完整。");
});

server.listen(port, "127.0.0.1", () => {
    console.log(`便携版网页服务已启动：http://localhost:${port}（/api -> ${apiTarget}）`);
});
