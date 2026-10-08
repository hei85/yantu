import { dataUrlToFile } from "@/lib/image-utils";
import { modelCapabilityConfigFor, videoResolutionRequest } from "@/lib/model-capabilities";
import { isHeihanAxonH3Video } from "@/lib/model-protocols";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionName } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

import { normalizeVideoAspectRatio, normalizeVideoSeconds, normalizeVideoSize } from "./video-validation";
import type { RequestOptions, ResolvedAiConfig, ApiVideoResponse, VideoGenerationTask, VideoGenerationTaskState } from "./video-contracts";
import type { VideoProviderDeps } from "./video-provider-deps";
import { orderVideoImageReferences } from "./video-reference-roles";

export async function createOpenAIVideoTask(deps: VideoProviderDeps, config: ResolvedAiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model);
    const orderedReferences = orderVideoImageReferences(references, options);
    if (config.interfaceType === "xai-video" || modelName.toLowerCase().includes("grok")) {
        const images = await Promise.all(orderedReferences.slice(0, 7).map((image) => imageToDataUrl(image)));
        const seconds = normalizeVideoSeconds(config.videoSeconds);
        const referenceMode = options?.videoEditOperation === "reference_to_video";
        const explicitFrameMode = !referenceMode && Boolean(options?.videoStartFrameNodeId || options?.videoEndFrameNodeId);
        if (config.interfaceType === "xai-video" && explicitFrameMode && (images.length > 1 || options?.videoEndFrameNodeId)) throw new Error("xAI 视频协议最多支持 1 张起始图，不支持尾帧或混合角色参考图");
        const imagePayload = config.interfaceType === "xai-video"
            ? referenceMode && images.length
                ? { reference_images: images.map((url) => ({ url })) }
                : images.length ? { image: { url: images[0] } } : {}
            : images.length ? { image: images[0], images } : {};
        // OpenAI-compatible JSON video endpoints use `size` for pixel
        // dimensions; only the NewAPI video-generations protocol uses a ratio.
        const videoSize = normalizeVideoSize(config.size);
        const payload = {
            model: modelName,
            prompt,
            duration: Number.parseInt(seconds, 10) || 6,
            seconds,
            ...(videoSize ? { size: videoSize } : {}),
            ...imagePayload,
        };
        try {
            const createPath = config.interfaceType === "xai-video" ? "/videos/generations" : "/videos";
            const created = deps.response.unwrapVideoResponse(await deps.transport.post<ApiVideoResponse>(deps.transport.apiUrl(createPath), payload, options));
            const id = deps.response.videoTaskId(created);
            if (!id) throw new Error("视频接口没有返回任务 ID");
            return { id, provider: "openai", model };
        } catch (error) {
            throw new Error(deps.response.readAxiosError(error, "视频任务创建失败"));
        }
    }
    const body = new FormData();
    body.append("model", modelName);
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    const videoSize = normalizeVideoSize(config.size);
    if (videoSize) body.append("size", videoSize);
    // Axon H3 reads aspect_ratio; keep this translation restricted to the
    // verified H3 relay and leave other /videos providers with size only.
    if (isHeihanAxonH3Video(config.baseUrl, modelName)) {
        const aspectRatio = normalizeVideoAspectRatio(config.size);
        if (aspectRatio) body.append("aspect_ratio", aspectRatio);
    }
    const resolution = videoResolutionRequest(modelCapabilityConfigFor(config, model).video!, config.vquality);
    if (resolution) body.append("resolution_name", resolution);
    body.append("preset", "normal");
    const files = await Promise.all(orderedReferences.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => body.append("input_reference[]", file));
    try {
        const created = deps.response.unwrapVideoResponse(await deps.transport.postForm<ApiVideoResponse>(deps.transport.apiUrl("/videos"), body, options));
        if (!created.id) throw new Error("视频接口没有返回任务 ID");
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(deps.response.readAxiosError(error, "视频任务创建失败"));
    }
}

export async function pollOpenAIVideoTask(deps: VideoProviderDeps, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = deps.response.unwrapVideoResponse(await deps.transport.get<ApiVideoResponse>(deps.transport.apiUrl(`/videos/${task.id}`), options));
        if (video.status === "completed" || video.status === "succeeded" || video.status === "success" || video.status === "done") {
            const resultUrl = video.video?.url || video.video_url || video.result_url;
            if (resultUrl) return { status: "completed", result: await deps.response.videoResultFromUrl(resultUrl, options) };
            const content = await deps.transport.getBlob(deps.transport.apiUrl(`/videos/${task.id}/content`), options);
            await deps.response.assertVideoBlob(content);
            return { status: "completed", result: { blob: content } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: video.error?.message || "视频生成失败" };
        return { status: "pending" };
    } catch (error) {
        throw new Error(deps.response.readAxiosError(error, "视频任务查询失败"));
    }
}
