import type { CanvasNode, CanvasSnapshot } from "./types.js";

type RecordValue = Record<string, any>;
type Status = "passed" | "failed" | "uncertain";
type Check = { name: string; status: Status; reason: string };
export type SelfCheckDependencies = {
    readRun: (runId: string) => Promise<unknown>;
    probe: (resourceId: string, fullDecode: boolean) => Promise<unknown>;
};

// This is a read-only audit. It never adopts media, records a pass, or submits a model.
export async function auditFilmWorkflow(snapshot: CanvasSnapshot, input: RecordValue, dependencies: SelfCheckDependencies) {
    const selected = Array.isArray(input.nodeIds) ? new Set(input.nodeIds) : null;
    const allNodes = snapshot.nodes || [];
    if (selected && [...selected].some(id => !allNodes.some(node => node.id === id))) throw new Error("自检包含不存在的节点 ID");
    const media = allNodes.filter(node => ["image", "video", "audio"].includes(node.type) && (!selected || selected.has(node.id)));
    const run = input.runId ? record(await dependencies.readRun(String(input.runId))) : null;
    if (run && run.canvasId !== snapshot.projectId) throw new Error("自检运行与目标画布不一致");
    const limit = Number(input.resourceLimit ?? 20);
    const resourceIds = [...new Set(media.map(resourceIdOf).filter(Boolean))];
    const inspected = resourceIds.slice(0, limit);
    const probes = new Map<string, { status: Status; reason: string; facts?: RecordValue }>();
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(2, inspected.length) }, async () => {
        while (cursor < inspected.length) {
            const id = inspected[cursor++];
            try {
                const result = record(await dependencies.probe(id, input.fullDecode !== false));
                const facts = record(result.probe);
                probes.set(id, { status: result.ok === false || facts.decoded === false ? "failed" : input.fullDecode !== false && facts.decoded !== true ? "uncertain" : "passed", reason: facts.decoded === true ? "实际资源完整解码成功；内容质量另查" : "未取得完整解码证据", facts: { decoded: facts.decoded, width: facts.width, height: facts.height, durationMs: facts.durationMs, audioStreams: facts.audioStreams, videoStreams: facts.videoStreams, subtitleStreams: facts.subtitleStreams } });
            } catch (error) {
                // Probe/query failure does not imply that the generation itself failed.
                probes.set(id, { status: "failed", reason: safeError(error) });
            }
        }
    }));
    const results = record(record(run?.quality).stepResults);
    const activeSteps = records(run?.steps).filter(step => step.superseded !== true && step.status !== "superseded");
    const mediaReports = media.map(node => {
        const id = resourceIdOf(node);
        const checks: Check[] = [];
        const probe = probes.get(id);
        checks.push({ name: "actual_resource_decode", status: !id ? "uncertain" : probe?.status || "uncertain", reason: !id ? "仅有网页/本地缓存引用，缺少可探测的 Resource ID" : probe?.reason || "未在本次资源限额内探测；需继续下一批" });
        const matching = Object.entries(results).filter(([key, value]) => {
            const result = record(value), evidence = record(result.evidence);
            const step = activeSteps.find(item => item.stepKey === key);
            return step && (evidence.resourceId === id || records(evidence.reviewedMedia).some(item => item.resourceId === id));
        });
        const semantic = matching.filter(([key]) => key.startsWith("quality:") || key === "stage:asset_package" || key.startsWith("storyboard:"));
        const current = semantic.filter(([key, value]) => {
            const step = activeSteps.find(item => item.stepKey === key)!;
            return Number(record(value).stepRevision) === Number(step.revision);
        });
        const outcomes = current.map(([key, value]) => {
            const result = record(value), evidence = record(result.evidence), semantic = record(evidence.semanticQuality);
            if (result.status === "failed") return "failed";
            if (result.status !== "passed") return "uncertain";
            const step = activeSteps.find(item => item.stepKey === key)!;
            const review = records(evidence.reviewedMedia).find(item => item.resourceId === id) || (evidence.resourceId === id ? evidence : {});
            const observations = records(review.checks);
            return semantic.status === "passed" && semantic.model && bounded(semantic.summary).trim() && evidence.inputFingerprint === step.inputFingerprint && observations.length && observations.every(item => item.status === "passed" && bounded(item.observation).trim()) ? "passed" : "uncertain";
        });
        checks.push({ name: "current_content_review", status: outcomes.includes("failed") ? "failed" : outcomes.includes("uncertain") ? "uncertain" : outcomes.includes("passed") ? "passed" : "uncertain", reason: current.length ? "采用当前步骤版本的内容检查；技术复用记录不充当内容检查" : "没有绑定本资源且匹配当前步骤版本的逐项内容证据；历史用户采用仍保留" });
        if (node.type === "video" || node.type === "audio") {
            const audioReviews = current.map(([, value]) => {
                const evidence = record(record(value).evidence);
                const individual = records(evidence.reviewedMedia).find(item => item.resourceId === id);
                return record(individual?.audioReview || (evidence.resourceId === id ? evidence.audioReview : null));
            });
            const listened = audioReviews.some(audio => audio.listeningStatus === "performed" && audio.voiceQuality === "passed" && bounded(audio.evaluator).trim() && bounded(audio.summary).trim());
            const audioFailed = audioReviews.some(audio => audio.voiceQuality === "failed");
            const silent = probe?.facts?.audioStreams === 0;
            const audioRequired = record(run?.deliveryContract).requireAudio !== false && record(run?.plan?.executionManifest).requireAudio !== false;
            checks.push({ name: "actual_audio_review", status: audioFailed ? "failed" : silent && !audioRequired ? "passed" : silent && audioRequired ? "failed" : listened ? "passed" : "uncertain", reason: audioFailed ? "实际声音检查已发现不合格内容" : silent ? audioRequired ? "合同需要音轨但实际无声" : "本合同不要求声音" : listened ? "有独立听审记录；仍需检查最终剪辑区间" : "音轨存在或 ASR 命中不证明音质、声线或口型；需实际声音检查" });
        }
        return { nodeId: node.id, title: node.title || "", type: node.type, resourceId: id, status: aggregate(checks), checks, facts: probe?.facts, reviewStepKeys: current.map(([key]) => key) };
    });
    const stageChecks: Check[] = [];
    if (!run) stageChecks.push({ name: "formal_run", status: "uncertain", reason: "未提供 runId，只检查当前媒体；不能宣称整片流程通过" });
    else {
        const pending = activeSteps.filter(step => step.status !== "succeeded");
        stageChecks.push({ name: "formal_stage_completion", status: pending.length ? "uncertain" : "passed", reason: pending.length ? `正式运行还有 ${pending.length} 个未通过步骤` : "全部活动步骤已完成，交付仍核对实际资源" });
        const contract = record(record(run.plan).executionManifest);
        stageChecks.push({ name: "self_check_contract", status: Number(contract.selfCheckVersion) === 1 && records(contract.selfCheckContracts).length > 0 ? "passed" : "uncertain", reason: Number(contract.selfCheckVersion) === 1 ? "采用逐资源、抽帧、听审覆盖合同" : "旧运行未声明逐资源自检合同；此次审计不改写旧计划或重生已采用图片" });
    }
    const pluginReports = readQualityPluginReports(snapshot, input.nodeIds);
    const checks = [...stageChecks, ...mediaReports.flatMap(item => item.checks)];
    const pendingReviews = mediaReports.filter(item => item.status !== "passed").map(item => ({ nodeId: item.nodeId, resourceId: item.resourceId, type: item.type, missing: item.checks.filter(check => check.status !== "passed").map(check => check.name), suggestedTools: item.type === "image" ? ["canvas_get_node", "canvas_read_quality_reports", "canvas_convert_media", "canvas_preflight_image_edit", "canvas_edit_image"] : ["film_probe_media", "canvas_extract_video_frames", "canvas_extract_video_audio", "film_record_step_result"] }));
    return { schemaVersion: 1, checkedAt: new Date().toISOString(), canvasId: snapshot.projectId, canvasRevision: snapshot.revision, runId: run?.id || "", runRevision: run?.revision, status: aggregate(checks), readyForDelivery: checks.length > 0 && checks.every(item => item.status === "passed"), scope: "resource_availability_and_existing_evidence_audit", mediaCount: media.length, uniqueResources: resourceIds.length, probedResources: inspected.length, omittedResourceIds: resourceIds.slice(limit), summary: mediaReports.reduce((sum, item) => ({ ...sum, [item.status]: sum[item.status] + 1 }), { passed: 0, failed: 0, uncertain: 0 }), stageChecks, mediaReports, pendingSteps: activeSteps.filter(step => step.status !== "succeeded").map(step => ({ stepKey: step.stepKey, status: step.status, reason: step.blockingReason || "" })), pendingReviews, pluginReports, limitations: ["本工具不自动产生视觉或声音通过结论，也不提交收费请求。", "抽帧只覆盖实际抽到的时刻；复杂动作、边界和异常时刻需要补查。", "几张模型图片、深度图或姿态图不能证明是同一几何空间或精确米数。", "审美批改没有问题不等于故事、手部、空间、音频和连续性全部合格。"] };
}

export function readQualityPluginReports(snapshot: CanvasSnapshot, nodeIds?: unknown) {
    const ids = Array.isArray(nodeIds) ? new Set(nodeIds) : null;
    const nodes = snapshot.nodes || [], edges = snapshot.connections || [];
    return nodes.filter(node => !ids || ids.has(node.id) || edges.some(edge => edge.toNodeId === node.id && ids.has(edge.fromNodeId))).flatMap(node => {
        const metadata = record(node.metadata), art = record(metadata.artCritique), portrait = record(metadata.portraitClearance);
        const sources = nodes.filter(source => edges.some(edge => edge.fromNodeId === source.id && edge.toNodeId === node.id));
        if (Object.keys(art).length) {
            const report = record(art.report);
            const stale = sources.length !== 1 || report.sourceFingerprint !== artFingerprint(sources[0]);
            return [{ nodeId: node.id, plugin: "ai-art-critique", sourceNodeIds: sources.map(source => source.id), status: art.status === "completed" && stale ? "stale" : art.status || "idle", reportAvailable: Boolean(art.report) && !stale, taskIds: Object.values(record(art.stageTaskIds)).filter(value => typeof value === "string"), summary: stale ? "输入已改变或缺失，报告不能复用" : bounded(report.summary), issues: stale ? [] : records(report.issues).map(issue => ({ id: issue.id, category: issue.category, title: bounded(issue.title), explanation: bounded(issue.explanation), severity: issue.severity, confidence: issue.confidence, verification: record(issue.verification).verdict, target: issue.target, suggestion: issue.suggestion })), productionPass: false }];
        }
        if (Object.keys(portrait).length) return [{ nodeId: node.id, plugin: "portrait-clearance", sourceNodeIds: sources.map(source => source.id), status: portrait.status || "idle", reportAvailable: Boolean(portrait.result), taskIds: [portrait.taskId].filter(Boolean), summary: "肖像风控结果仅供其适用范围；不作为影片身份/空间/动作通过依据", issues: [], productionPass: false }];
        return [];
    });
}

function artFingerprint(node: CanvasNode) {
    const m = record(node.metadata), value = String(m.content || m.previewContent || "");
    const compact = value.length <= 2048 ? value : `${value.slice(0, 1024)}|${value.slice(-1024)}|${value.length}`;
    const source = [node.id, m.storageKey || "", compact, m.mimeType || "", m.bytes || "", m.naturalWidth || "", m.naturalHeight || ""].join("|");
    let hash = 2166136261;
    for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
    return `v1-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
function resourceIdOf(node: CanvasNode) { const m = record(node.metadata); return typeof m.resourceId === "string" && m.resourceId ? m.resourceId : typeof m.storageKey === "string" && m.storageKey.startsWith("resource:") ? m.storageKey.slice(9) : ""; }
function aggregate(checks: Check[]): Status { return checks.some(item => item.status === "failed") ? "failed" : !checks.length || checks.some(item => item.status === "uncertain") ? "uncertain" : "passed"; }
function record(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function records(value: unknown): RecordValue[] { return Array.isArray(value) ? value.map(record) : []; }
function bounded(value: unknown) { return typeof value === "string" ? value.slice(0, 2400) : ""; }
function safeError(value: unknown) { return bounded(value instanceof Error ? value.message : "资源探测失败").replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]").replace(/\bhttps?:\/\/\S+/g, "[media address]"); }
