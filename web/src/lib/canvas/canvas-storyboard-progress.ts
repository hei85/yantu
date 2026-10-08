import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type StoryboardAssetRole, type StoryboardRow } from "@/types/canvas";

export type StoryboardPipelineItemState = "missing" | "idle" | "loading" | "success" | "error";

export type StoryboardPipelineStage = {
    total: number;
    created: number;
    success: number;
    failed: number;
    loading: number;
    incomplete: number;
    nodeIds: string[];
};

export type StoryboardPipelineRow = {
    row: StoryboardRow;
    imageNode?: CanvasNodeData;
    imageState: StoryboardPipelineItemState;
    videoNode?: CanvasNodeData;
    videoState: StoryboardPipelineItemState;
    videoRoute: "t2v" | "i2v" | "other" | "unknown";
    assetState: "none" | "linked" | "broken";
    assetRequirementState: "missing_required_scene" | "missing_required_asset" | "text_only_ready" | "satisfied" | "broken" | "unknown";
    audioState: "not_requested" | "pending" | "linked" | "broken";
    segmentNodeIds: string[];
    segmentBindingsReady: boolean;
    taskIds: string[];
};

export type CanvasStoryboardPipelineProgress = {
    rows: StoryboardPipelineRow[];
    images: StoryboardPipelineStage;
    videos: StoryboardPipelineStage;
    final: StoryboardPipelineStage;
    successfulVideoNodeIds: string[];
    finalNodeIds: string[];
};

export function deriveStoryboardPipelineProgress(scriptNode: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasStoryboardPipelineProgress {
    const rows = scriptNode.metadata?.storyboard?.rows || [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const pipelineRows = rows.map((row): StoryboardPipelineRow => {
        const imageNode = row.imageNodeId ? nodeById.get(row.imageNodeId) : undefined;
        const videoNode = row.videoNodeId ? nodeById.get(row.videoNodeId) : undefined;
        const segmentBindings = [...(row.segmentBindings || [])].sort((left, right) => left.order - right.order);
        const segmentNodeIds = segmentBindings.map((binding) => binding.videoNodeId).filter((id): id is string => Boolean(id));
        const segmentStates = segmentBindings.map((binding) => binding.status || "planned");
        const segmentBindingsReady = segmentBindings.length > 0 && segmentBindings.every((binding) => segmentOutputMatchesBinding(binding, nodeById));
        const primaryVideoState = nodePipelineState(videoNode, CanvasNodeType.Video);
        const videoState = segmentStates.includes("failed")
            ? "error"
            : segmentStates.includes("uncertain") || segmentStates.includes("submitted") || segmentStates.includes("running")
              ? "loading"
              : segmentStates.length > 0
                ? segmentStates.every((state) => state === "succeeded") && segmentBindingsReady ? "success" : "missing"
                : primaryVideoState === "success" && !primaryVideoOutputHasTaskAndResource(videoNode) ? "missing" : primaryVideoState;
        const assetBindings = row.assetBindings || [];
        const assetState = assetBindings.some((binding) => !nodeById.has(binding.nodeId))
            ? "broken"
            : assetBindings.length > 0 ? "linked" : "none";
        const operation = videoNode?.metadata?.videoEditOperation || row.videoOperation;
        const videoRoute = operation === "image_to_video" || Boolean(videoNode?.metadata?.videoStartFrameNodeId)
            ? "i2v"
            : operation === "text_to_video" ? "t2v"
              : operation ? "other"
                : "unknown";
        const requiredRoles = [...new Set(row.requiredAssetRoles || [])];
        const missingRequiredRoles = requiredRoles.filter((role) => !assetBindings.some((binding) => {
            const node = nodeById.get(binding.nodeId);
            return binding.role === role && Boolean(node) && storyboardAssetRoleMatchesNode(role, node!);
        }));
        const hasBrokenAssetReference = assetBindings.some((binding) => !nodeById.has(binding.nodeId));
        const hasTextConstraints = [row.plotDescription, row.narrativeIntent, row.lightingAndAtmosphere, row.performanceBlocking, row.imageGenerationPrompt, row.videoMotionPrompt]
            .some(hasNonBlankText) || (row.characters || []).some((character) => hasNonBlankText(character.characterName) || hasNonBlankText(character.characterDescription));
        const assetRequirementState = hasBrokenAssetReference
            ? "broken"
            : missingRequiredRoles.includes("environment") ? "missing_required_scene"
              : missingRequiredRoles.length ? "missing_required_asset"
                : videoRoute === "t2v" && !imageNode && hasTextConstraints ? "text_only_ready"
                  : requiredRoles.length ? "satisfied"
                    : "unknown";
        const audioBindings = assetBindings.filter((binding) => binding.role === "audio");
        const requestedAudio = [row.dialogue, row.voiceover, row.audioEffects].some(hasNonBlankText);
        const audioState = audioBindings.some((binding) => {
            const audioNode = nodeById.get(binding.nodeId);
            return !audioNode || audioNode.type !== CanvasNodeType.Audio;
        })
            ? "broken"
            : audioBindings.length > 0 ? "linked" : requestedAudio ? "pending" : "not_requested";
        return {
            row,
            imageNode: imageNode?.type === CanvasNodeType.Image ? imageNode : undefined,
            imageState: nodePipelineState(imageNode, CanvasNodeType.Image),
            videoNode: videoNode?.type === CanvasNodeType.Video ? videoNode : undefined,
            videoState,
            videoRoute,
            assetState,
            assetRequirementState,
            audioState,
            segmentNodeIds,
            segmentBindingsReady,
            taskIds: [...new Set(segmentBindings.map((binding) => binding.taskId).filter((id): id is string => Boolean(id)))],
        };
    });
    const imageNodes = pipelineRows.flatMap((item) => item.imageNode ? [item.imageNode] : []);
    const videoNodes = pipelineRows.flatMap((item) => item.videoNode ? [item.videoNode] : []);
    const videoNodeIds = new Set(videoNodes.map((node) => node.id));
    const linkedFinalNodes = nodes.filter((node) => node.type === CanvasNodeType.Video
        && node.metadata?.workflowKind === "final"
        && connections.some((connection) => connection.toNodeId === node.id && (connection.fromNodeId === scriptNode.id || videoNodeIds.has(connection.fromNodeId))));
    const successfulVideoNodeIds = pipelineRows.flatMap((item) => item.videoState === "success" && item.videoNode ? [item.videoNode.id] : []);
    return {
        rows: pipelineRows,
        images: summarizeStage(pipelineRows.map((item) => ({ state: item.imageState, node: item.imageNode })), rows.length),
        videos: summarizeStage(pipelineRows.map((item) => ({ state: item.videoState, node: item.videoNode })), rows.length),
        final: summarizeFinalStage(linkedFinalNodes, rows.length > 0 || linkedFinalNodes.length > 0),
        successfulVideoNodeIds,
        finalNodeIds: linkedFinalNodes.map((node) => node.id),
    };
}

function hasNonBlankText(value: unknown): boolean {
    return typeof value === "string" && value.trim().length > 0;
}

export function storyboardRowProductionLabel(item: StoryboardPipelineRow) {
    const segments = item.row.segmentBindings || [];
    if (segments.some((segment) => segment.status === "uncertain")) return "状态待核对";
    if (segments.some((segment) => segment.status === "failed") || item.videoState === "error") return "视频失败";
    if (segments.some((segment) => segment.status === "running" || segment.status === "submitted") || item.videoState === "loading") return "视频进行中";
    if (item.assetRequirementState === "missing_required_scene") return "缺必需场景";
    if (item.assetRequirementState === "missing_required_asset") return "缺必需资产";
    if (item.assetRequirementState === "broken") return "资产引用失效";
    if (item.assetRequirementState === "text_only_ready" && item.videoState !== "success") return "无需首帧";
    if (segments.length > 0 && segments.every((segment) => segment.status === "succeeded")) {
        return item.segmentBindingsReady ? `片段完成 ${segments.length}/${segments.length}` : "结果待关联";
    }
    if (item.videoState === "success") return "视频完成";
    if (item.row.status === "success" && item.videoState === "missing") return "结果待关联";
    if (item.imageState === "error") return "首帧失败";
    if (item.imageState === "loading") return "首帧生成中";
    if (item.imageState === "success") return "首帧就绪";
    if (item.row.status === "error") return "分镜失败";
    if (item.row.status === "loading") return "处理中";
    if (item.row.status === "ready") return "已规划";
    return "待生成";
}

export function storyboardRowProductionDetails(item: StoryboardPipelineRow) {
    const route = item.videoRoute === "t2v" ? "T2V" : item.videoRoute === "i2v" ? "I2V" : item.videoRoute === "other" ? "其他视频路线" : "路线待选";
    const assets = item.assetRequirementState === "missing_required_scene" ? "缺必需场景"
        : item.assetRequirementState === "missing_required_asset" ? "缺必需资产"
          : item.assetRequirementState === "broken" ? "资产引用失效"
            : item.assetRequirementState === "text_only_ready" ? "无需首帧/资产文字约束齐备"
              : item.assetRequirementState === "satisfied" ? "必需资产已绑定"
                : item.assetState === "linked" ? "资产已关联" : "资产要求待确认";
    const audio = item.audioState === "broken" ? "音频素材失效" : item.audioState === "linked" ? "音频素材已关联" : item.audioState === "pending" ? "声音待处理" : "无对白/音效要求";
    const quality = item.row.errorDetails || item.row.status === "error" || item.videoState === "error" ? "镜头失败，待修复" : "镜头质检待验";
    return [route, assets, audio, quality];
}

export function storyboardRowFocusNodeId(item: StoryboardPipelineRow) {
    return item.videoNode?.id || item.segmentNodeIds[0] || item.imageNode?.id || "";
}

function nodePipelineState(node: CanvasNodeData | undefined, expectedType: CanvasNodeType): StoryboardPipelineItemState {
    if (!node || node.type !== expectedType) return "missing";
    if (node.metadata?.status === "success" && node.metadata.content) return "success";
    if (node.metadata?.status === "loading") return "loading";
    if (node.metadata?.status === "error") return "error";
    return "idle";
}

function segmentOutputMatchesBinding(binding: NonNullable<StoryboardRow["segmentBindings"]>[number], nodeById: Map<string, CanvasNodeData>) {
    if (!binding.videoNodeId || !binding.taskId || !binding.resourceId) return false;
    const node = nodeById.get(binding.videoNodeId);
    const metadata = node?.metadata as (CanvasNodeData["metadata"] & Record<string, unknown>) | undefined;
    if (node?.type !== CanvasNodeType.Video || metadata?.status !== "success" || !metadata.content) return false;
    if (metadata.taskId !== binding.taskId || metadata.taskStatus !== "succeeded") return false;
    const storageKey = typeof metadata.storageKey === "string" ? metadata.storageKey : "";
    const storageResourceId = storageKey.startsWith("resource:") ? storageKey.slice("resource:".length) : "";
    const resourceId = typeof metadata.resourceId === "string" ? metadata.resourceId : storageResourceId;
    return resourceId === binding.resourceId;
}

function primaryVideoOutputHasTaskAndResource(node: CanvasNodeData | undefined) {
    if (!node || node.type !== CanvasNodeType.Video) return false;
    const metadata = node.metadata as (CanvasNodeData["metadata"] & Record<string, unknown>) | undefined;
    if (!metadata || metadata.workflowKind === "final" || !metadata.taskId || metadata.taskStatus !== "succeeded") return false;
    const storageKey = typeof metadata.storageKey === "string" ? metadata.storageKey : "";
    const storageResourceId = storageKey.startsWith("resource:") ? storageKey.slice("resource:".length) : "";
    return Boolean(typeof metadata.resourceId === "string" ? metadata.resourceId : storageResourceId);
}

function storyboardAssetRoleMatchesNode(role: StoryboardAssetRole, node: CanvasNodeData) {
    if (role === "audio") return node.type === CanvasNodeType.Audio;
    if (role === "motion") return node.type === CanvasNodeType.Video;
    // A row's explicit binding is the semantic role assertion. Do not require
    // the reusable node's library category metadata to repeat that assertion.
    return node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Drawing;
}

function summarizeStage(items: Array<{ state: StoryboardPipelineItemState; node?: CanvasNodeData }>, total: number): StoryboardPipelineStage {
    const success = items.filter((item) => item.state === "success").length;
    const failed = items.filter((item) => item.state === "error").length;
    const loading = items.filter((item) => item.state === "loading").length;
    const created = items.filter((item) => Boolean(item.node)).length;
    return {
        total,
        created,
        success,
        failed,
        loading,
        incomplete: Math.max(0, total - success),
        nodeIds: items.flatMap((item) => item.node ? [item.node.id] : []),
    };
}

function summarizeFinalStage(nodes: CanvasNodeData[], enabled: boolean): StoryboardPipelineStage {
    if (!enabled) return { total: 0, created: 0, success: 0, failed: 0, loading: 0, incomplete: 0, nodeIds: [] };
    const success = nodes.some((node) => node.metadata?.productionDeliveryStatus === "passed") ? 1 : 0;
    const loading = success ? 0 : nodes.some((node) => nodePipelineState(node, CanvasNodeType.Video) === "loading") ? 1 : 0;
    const failed = success || loading ? 0 : nodes.some((node) => node.metadata?.productionDeliveryStatus === "failed" || nodePipelineState(node, CanvasNodeType.Video) === "error") ? 1 : 0;
    return {
        total: 1,
        created: nodes.length ? 1 : 0,
        success,
        failed,
        loading,
        incomplete: success ? 0 : 1,
        nodeIds: nodes.map((node) => node.id),
    };
}

export function pipelineStatusLabel(stage: StoryboardPipelineStage) {
    if (!stage.total) return "待开始";
    if (stage.success >= stage.total) return "已完成";
    if (stage.loading) return `${stage.success}/${stage.total} · 进行中`;
    if (stage.failed) return `${stage.success}/${stage.total} · 失败 ${stage.failed}`;
    if (stage.created) return `${stage.success}/${stage.total} · 已创建 ${stage.created}`;
    return `0/${stage.total}`;
}
