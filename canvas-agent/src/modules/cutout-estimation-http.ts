import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { Request, RequestHandler, Response } from "express";

import type { LocalRuntimeModule } from "../local-runtime.js";
import { resolveEnvPath } from "./runtime-env-path.js";

const DEFAULT_MODEL_ID = "isnet-general-use";
const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const MAX_PROTOCOL_LINE_BYTES = 48 * 1024 * 1024;
const DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=_-]+)$/;

export type CutoutRuntimePaths = {
    pythonPath: string;
    scriptPath: string;
    hfHome: string;
    modelId: string;
    configured: boolean;
    modelCached: boolean;
    reason?: "python_missing" | "worker_missing";
};

export type CutoutRuntimeStatus = {
    configured: boolean;
    modelCached: boolean;
    loaded: boolean;
    device: "cpu";
    modelId: string;
    reason?: string;
};

type CutoutWorkerSuccess = {
    ok: true;
    requestId: string;
    mimeType: "image/png";
    width: number;
    height: number;
    modelId: string;
    device: "cpu";
    pngBase64: string;
};

export class CutoutRuntimeError extends Error {
    constructor(readonly code: string, message: string, readonly statusCode = 503) {
        super(message);
        this.name = "CutoutRuntimeError";
    }
}

export function createCutoutEstimationHttpModule(): LocalRuntimeModule {
    const worker = new CutoutEstimationWorker();
    return {
        descriptor: {
            id: "cutout-estimation",
            displayName: "rembg ISNet 本机透明抠图",
            apiVersion: 1,
            scopes: ["cutout:status", "cutout:run"],
        },
        routes: [
            {
                method: "GET",
                path: "/cutout-estimation/status",
                scope: "cutout:status",
                handler: asyncRoute(async (_request, response) => {
                    const status = worker.status();
                    response.json({
                        ok: true,
                        module: "cutout-estimation",
                        apiVersion: 1,
                        ready: status.configured && status.modelCached,
                        ...status,
                    });
                }),
            },
            {
                method: "POST",
                path: "/cutout-estimation/run",
                scope: "cutout:run",
                handler: asyncRoute(async (request, response) => {
                    const body = parseBody(request);
                    const dataUrl = parseCutoutInput(body);
                    const result = await worker.run({ dataUrl });
                    response.json({
                        ok: true,
                        module: "cutout-estimation",
                        apiVersion: 1,
                        result,
                    });
                }),
            },
        ],
        dispose: () => worker.dispose(),
        publicHealth: () => {
            const status = worker.status();
            return { cutoutEstimation: status.configured && status.modelCached ? "available" : "unavailable" };
        },
    };
}

export function resolveCutoutRuntimePaths(env: NodeJS.ProcessEnv = process.env): CutoutRuntimePaths {
    const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const configuredProjectRoot = env.CANVAS_PROJECT_ROOT?.trim();
    const projectRoots = [
        configuredProjectRoot ? resolveEnvPath(configuredProjectRoot) : undefined,
        path.resolve(moduleRoot, ".."),
        path.resolve(process.cwd()),
    ].filter((value): value is string => Boolean(value));
    const projectRoot = configuredProjectRoot
        ? resolveEnvPath(configuredProjectRoot)
        : projectRoots.find((value) => fs.existsSync(path.join(value, ".local"))) || projectRoots[0]!;
    const scriptCandidates = [
        path.join(moduleRoot, "python", "cutout_runtime.py"),
        path.join(projectRoot, "canvas-agent", "python", "cutout_runtime.py"),
    ];
    const scriptPath = scriptCandidates.find((value) => fs.existsSync(value)) || scriptCandidates[0]!;
    const pythonCandidates = (env.CANVAS_CUTOUT_PYTHON?.trim() || env.CANVAS_DEPTH_PYTHON?.trim())
        ? [resolveEnvPath(env.CANVAS_CUTOUT_PYTHON?.trim() || env.CANVAS_DEPTH_PYTHON!.trim())]
        : process.platform === "win32"
            ? [path.join(projectRoot, ".local", "depth-anything-v2", "venv", "Scripts", "python.exe")]
            : [path.join(projectRoot, ".local", "depth-anything-v2", "venv", "bin", "python")];
    const pythonPath = pythonCandidates[0]!;
    const hfHome = resolveEnvPath(env.CANVAS_CUTOUT_MODEL_HOME?.trim() || path.join(projectRoot, ".local", "cache", "rembg"));
    const modelId = DEFAULT_MODEL_ID;
    const modelCacheDir = path.join(hfHome, "isnet-general-use.onnx");
    const workerExists = fs.existsSync(scriptPath);
    const pythonExists = fs.existsSync(pythonPath);
    return {
        pythonPath,
        scriptPath,
        hfHome,
        modelId,
        configured: workerExists && pythonExists,
        modelCached: workerExists && pythonExists && isUsableModelFile(modelCacheDir),
        ...(pythonExists ? {} : { reason: "python_missing" as const }),
        ...(!workerExists ? { reason: "worker_missing" as const } : {}),
    };
}

function isUsableModelFile(modelPath: string) {
    try {
        return fs.statSync(modelPath).isFile() && fs.statSync(modelPath).size >= 100_000_000;
    } catch {
        return false;
    }
}
export class CutoutEstimationWorker {
    private paths = resolveCutoutRuntimePaths();
    private child?: ChildProcessWithoutNullStreams;
    private stdoutBuffer = "";
    private stderrBuffer = "";
    private requestCounter = 0;
    private loaded = false;
    private readonly pending = new Map<string, { resolve: (value: CutoutWorkerSuccess) => void; reject: (error: unknown) => void }>();

    status(): CutoutRuntimeStatus {
        const paths = this.refreshPaths();
        return {
            configured: paths.configured,
            modelCached: paths.modelCached,
            loaded: this.loaded,
            device: "cpu",
            modelId: paths.modelId,
            ...(paths.reason ? { reason: paths.reason } : {}),
        };
    }

    async run(input: { dataUrl: string }) {
        validateCutoutDataUrl(input.dataUrl);
        const paths = this.refreshPaths();
        if (!paths.configured) {
            throw new CutoutRuntimeError(
                "cutout_runtime_unavailable",
                paths.reason === "worker_missing" ? "本机 AI 透明抠图运行文件不存在" : "未找到本机 AI 透明抠图 Python 环境",
            );
        }
        const child = this.ensureChild();
        const requestId = `cutout-${Date.now().toString(36)}-${(++this.requestCounter).toString(36)}`;
        const response = new Promise<CutoutWorkerSuccess>((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
        });
        try {
            child.stdin.write(JSON.stringify({ requestId, dataUrl: input.dataUrl }) + "\n");
        } catch {
            this.pending.delete(requestId);
            throw new CutoutRuntimeError("cutout_runtime_unavailable", "本机 AI 透明抠图进程无法写入");
        }
        return response;
    }

    dispose() {
        const child = this.child;
        this.child = undefined;
        this.loaded = false;
        this.rejectPending(new CutoutRuntimeError("cutout_runtime_unavailable", "本机 AI 透明抠图进程已停止"));
        if (child && !child.killed) child.kill();
    }

    private ensureChild() {
        if (this.child && !this.child.killed) return this.child;
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(this.paths.pythonPath, [this.paths.scriptPath], {
                cwd: path.dirname(this.paths.scriptPath),
                env: {
                    ...process.env,
                    HF_HOME: this.paths.hfHome,
                    HF_HUB_CACHE: path.join(this.paths.hfHome, "hub"),
                    HF_HUB_OFFLINE: "1",
                    TRANSFORMERS_OFFLINE: "1",
                    HF_HUB_DISABLE_TELEMETRY: "1",
                    HF_HUB_DISABLE_PROGRESS_BARS: "1",
                    TRANSFORMERS_VERBOSITY: "error",
                    CANVAS_CUTOUT_MODEL_HOME: this.paths.hfHome,
                },
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            });
        } catch {
            throw new CutoutRuntimeError("cutout_runtime_unavailable", "本机 AI 透明抠图进程无法启动");
        }
        this.child = child;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
        child.stderr.on("data", (chunk: string) => {
            this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4_000);
        });
        child.on("error", () => this.handleChildExit(child));
        child.on("exit", () => this.handleChildExit(child));
        return child;
    }

    private refreshPaths() {
        if (!this.child) this.paths = resolveCutoutRuntimePaths();
        return this.paths;
    }

    private consumeStdout(chunk: string) {
        this.stdoutBuffer += chunk;
        if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
            this.child?.kill();
            this.handleChildExit(this.child);
            return;
        }
        while (true) {
            const newline = this.stdoutBuffer.indexOf("\n");
            if (newline < 0) return;
            const line = this.stdoutBuffer.slice(0, newline).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            if (!line) continue;
            let value: unknown;
            try { value = JSON.parse(line); } catch { continue; }
            if (!isRecord(value) || typeof value.requestId !== "string") continue;
            const pending = this.pending.get(value.requestId);
            if (!pending) continue;
            this.pending.delete(value.requestId);
            if (value.ok === true) {
                if (value.mimeType !== "image/png" || !isPositiveInteger(value.width) || !isPositiveInteger(value.height) || typeof value.modelId !== "string" || value.device !== "cpu" || typeof value.pngBase64 !== "string" || !value.pngBase64) {
                    pending.reject(new CutoutRuntimeError("cutout_response_invalid", "本机 AI 透明抠图响应无效", 500));
                    continue;
                }
                this.loaded = true;
                pending.resolve(value as unknown as CutoutWorkerSuccess);
                continue;
            }
            const code = typeof value.code === "string" ? value.code : "cutout_inference_failed";
            const statusCode = code === "cutout_model_missing" || code === "cutout_dependencies_missing" ? 503 : code === "cutout_input_invalid" ? 400 : 500;
            pending.reject(new CutoutRuntimeError(code, typeof value.message === "string" ? value.message : "本机 AI 透明抠图推理失败", statusCode));
        }
    }

    private handleChildExit(child?: ChildProcessWithoutNullStreams) {
        if (!child || this.child !== child) return;
        this.child = undefined;
        this.loaded = false;
        this.stderrBuffer = "";
        this.stdoutBuffer = "";
        this.rejectPending(new CutoutRuntimeError("cutout_runtime_unavailable", "本机 AI 透明抠图进程已退出"));
    }

    private rejectPending(error: CutoutRuntimeError) {
        for (const { reject } of this.pending.values()) reject(error);
        this.pending.clear();
    }
}

export function validateCutoutDataUrl(value: string) {
    const match = DATA_URL_PATTERN.exec(value);
    if (!match) throw new CutoutRuntimeError("cutout_input_invalid", "AI 透明抠图转换只支持 PNG、JPEG 或 WebP 图片", 400);
    const bytes = Buffer.from(match[2]!, "base64");
    if (!bytes.length || bytes.length > MAX_INPUT_BYTES) throw new CutoutRuntimeError("cutout_input_invalid", "AI 透明抠图图片不能超过 12MB", 400);
}

function parseCutoutInput(body: Record<string, unknown>) {
    const keys = Object.keys(body).sort();
    if (keys.length !== 3 || keys[0] !== "dataUrl" || keys[1] !== "operation" || keys[2] !== "schemaVersion" || body.schemaVersion !== 1 || body.operation !== "cutout" || typeof body.dataUrl !== "string") {
        throw new CutoutRuntimeError("cutout_input_invalid", "AI 透明抠图转换请求字段无效", 400);
    }
    validateCutoutDataUrl(body.dataUrl);
    return body.dataUrl;
}

function parseBody(request: Request): Record<string, unknown> {
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) return {};
    try {
        const value = JSON.parse(request.body.toString("utf8")) as unknown;
        return isRecord(value) ? value : {};
    } catch {
        return {};
    }
}

function asyncRoute(action: (request: Request, response: Response) => Promise<void>): RequestHandler {
    return (request, response, next) => {
        void action(request, response).catch((error) => {
            if (response.headersSent) return next(error);
            if (error instanceof CutoutRuntimeError) {
                response.status(error.statusCode).json({ ok: false, code: error.code, message: error.message });
                return;
            }
            response.status(503).json({ ok: false, code: "cutout_runtime_unavailable", message: "本机 AI 透明抠图运行时不可用" });
        });
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}
