type ProductionRun = {
    id: string;
    canvasId?: string;
    domainProjectId?: string;
    revision: number;
    policy?: Record<string, unknown>;
    steps: Array<{ id: string; kind: string; selectedStrategyId?: string; estimatedCostMicros?: number }>;
    attempts: Array<{ idempotencyKey: string; capabilityRevision: string }>;
};

type BackendEnvelope<T> = { code: number; data?: T; msg?: string };

export class PortableProductionApi {
    private readonly baseUrl: string;

    constructor(baseUrl: string, private readonly request: typeof fetch = fetch) {
        const url = new URL(baseUrl);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/api" || url.search || url.hash || url.username || url.password) {
            throw new Error("便携 ProductionRun API 只允许配置为本机 loopback /api 地址");
        }
        this.baseUrl = url.origin + "/api";
    }

    async call(tool: "film_get_run" | "film_submit_step", input: Record<string, unknown>, canvas?: { canvasId: string; domainProjectId?: string }) {
        await this.assertPortableSelfUseBackend();
        const runId = stringValue(input.runId);
        const after = Number.isInteger(input.afterSequence) && Number(input.afterSequence) > 0 ? `?after=${Number(input.afterSequence)}` : "";
        const run = await this.get<ProductionRun>(`/production-runs/${encodeURIComponent(runId)}${after}`);
        if (tool === "film_get_run") return run;
        if (!canvas) throw new Error("提交 ProductionRun 步骤需要当前连接的画布");
        if (run.canvasId !== canvas.canvasId
            || (run.domainProjectId && run.domainProjectId !== canvas.domainProjectId)) {
            throw new Error("ProductionRun 与当前连接画布/项目不匹配；请读取画布与制作运行后再提交");
        }

        const stepId = stringValue(input.stepId);
        const step = run.steps.find((item) => item.id === stepId);
        if (!step) throw new Error(`制作步骤 ${stepId} 不存在；请重新读取 film_get_run`);
        const taskInput = recordValue(input.task);
        const task = { ...taskInput };
        const strategy = parseSelectedStrategy(step.selectedStrategyId || "");
        if (strategy) {
            if (task.model && task.model !== strategy.model) {
                throw new Error(`步骤计划已锁定模型 ${strategy.model}，请求指定了 ${task.model}；请更新计划并重新授权`);
            }
            task.model = strategy.model;
        }
        const priorAttempt = run.attempts.find((attempt) => attempt.idempotencyKey === stringValue(input.idempotencyKey));
        const capabilityRevision = priorAttempt?.capabilityRevision || strategy?.capabilityRevision || stringValue(input.capabilityRevision);
        if (!task.model || !capabilityRevision) {
            throw new Error("步骤缺少持久 selectedStrategy 模型/能力版本；请更新计划并重新读取 film_list_models");
        }

        const unknownPricingAuthorized = String(run.policy?.authorizationStatus || "").toLowerCase() === "authorized"
            && String(run.policy?.budgetPolicy || "").toLowerCase() === "unbounded";
        const estimate = Number.isInteger(input.estimatedCostMicros)
            ? Number(input.estimatedCostMicros)
            : Number.isInteger(step.estimatedCostMicros) ? Number(step.estimatedCostMicros) : undefined;
        const estimatedCostMicros = estimate ?? (unknownPricingAuthorized ? 0 : undefined);
        if (estimatedCostMicros === undefined || estimatedCostMicros < 0 || (estimatedCostMicros === 0 && !unknownPricingAuthorized)) {
            throw new Error("必须提供真实核验的正数费用预估；只有持久授权的 unbounded 运行可用 0 表示未知费用，0 不代表免费");
        }
        if (step.kind === "video" && run.policy?.videoModelFamily && !videoModelMatchesFamily(stringValue(task.model), String(run.policy.videoModelFamily))) {
            throw new Error(`步骤计划模型 ${task.model} 不属于已授权的 ${String(run.policy.videoModelFamily)} 系列`);
        }
        const body = {
            expectedRevision: integerValue(input.expectedRevision, "expectedRevision"),
            stepId,
            idempotencyKey: stringValue(input.idempotencyKey),
            capabilityRevision,
            estimatedCostMicros,
            ...(input.retryOf ? { retryOf: stringValue(input.retryOf) } : {}),
            task,
        };
        return await this.post(`/production-runs/${encodeURIComponent(runId)}/steps/submit`, body);
    }

    private async assertPortableSelfUseBackend() {
        const health = await this.get<Record<string, unknown>>("/health/ready");
        if (health.status !== "ok" || health.ready !== true) throw new Error("配置的 ProductionRun 后端未就绪");

        // Deliberately send no cookies or identity headers. A non-login portable backend
        // resolves currentUser from its official loopback-only product mode.
        const session = await this.get<{ user?: { id?: string } | null }>("/auth/session");
        if (!session.user?.id) throw new Error("后端未确认便携免登录本地身份；拒绝直接 ProductionRun 调用");
        const [current, selfUse] = await Promise.all([
            this.get<{ setting?: RuntimePolicy }>("/admin/settings/runtime-policy"),
            this.get<{ setting?: RuntimePolicy }>("/admin/settings/runtime-policy/self-use"),
        ]);
        if (!current.setting || !selfUse.setting || !sameRuntimePolicy(current.setting, selfUse.setting)) {
            throw new Error("后端未确认 self-use 运行策略；拒绝直接 ProductionRun 调用");
        }
    }

    private async get<T>(path: string): Promise<T> {
        return await this.send<T>(path, "GET");
    }

    private async post<T>(path: string, body: unknown): Promise<T> {
        return await this.send<T>(path, "POST", body);
    }

    private async send<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
        const response = await this.request(`${this.baseUrl}${path}`, {
            method,
            credentials: "omit",
            redirect: "error",
            headers: body === undefined ? undefined : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`ProductionRun 后端请求失败（HTTP ${response.status}）`);
        const envelope = await response.json() as BackendEnvelope<T>;
        if (envelope.code !== 0 || envelope.data === undefined) throw new Error(envelope.msg || "ProductionRun 后端拒绝请求");
        return envelope.data;
    }
}

type RuntimePolicy = { resource: Record<string, unknown>; task: Record<string, unknown>; request: Record<string, unknown> };

function sameRuntimePolicy(a: RuntimePolicy, b: RuntimePolicy) {
    return stableJson(a.resource) === stableJson(b.resource)
        && stableJson(a.task) === stableJson(b.task)
        && stableJson(a.request) === stableJson(b.request);
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function parseSelectedStrategy(value: string) {
    const at = value.lastIndexOf("@");
    if (at <= 0) return undefined;
    const [revision] = value.slice(at + 1).split(/:(?=[^:]+$)/);
    if (!/^[^:]+:\d+$/.test(revision || "")) return undefined;
    return { model: value.slice(0, at), capabilityRevision: revision };
}

function videoModelMatchesFamily(model: string, family: string) {
    const normalize = (value: string) => {
        const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
        return normalized === "h3" ? "minimax_h3" : normalized;
    };
    const normalizedFamily = normalize(family);
    const modelKey = normalize(model.split("::").pop() || model);
    return !normalizedFamily || modelKey === normalizedFamily || modelKey.startsWith(`${normalizedFamily}_`);
}

function stringValue(value: unknown) {
    if (typeof value !== "string" || !value.trim()) throw new Error("ProductionRun 请求缺少必填字段");
    return value.trim();
}

function integerValue(value: unknown, name: string) {
    if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${name} 必须是非负整数`);
    return Number(value);
}

function recordValue(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ProductionRun task 参数无效");
    return value as Record<string, unknown>;
}
