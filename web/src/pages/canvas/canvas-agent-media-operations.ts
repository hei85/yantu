import type { CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import type { CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import type { CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import type { CanvasVideoFrameParams } from "@/components/canvas/canvas-video-frame-dialog";
import type { CanvasNodeTypeId } from "@/types/canvas";

export type CanvasAgentMediaNodeSummary = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    assetId?: string;
    assetPersisted: boolean;
    width?: number;
    height?: number;
    durationMs?: number;
};

export type CanvasAgentMediaOperationResult = {
    projectId: string;
    operation: "image.crop" | "image.split" | "image.upscale" | "video.extract_frames" | "video.extract_audio" | "video.trim";
    sourceNodeId: string;
    requestedCount: number;
    createdNodes: CanvasAgentMediaNodeSummary[];
    warnings: string[];
    partial: boolean;
};

export type CanvasAgentMediaOperations = {
    cropImage(input: { nodeId: string; crop: CanvasImageCropRect; beforeCommit: () => Promise<void> }): Promise<CanvasAgentMediaOperationResult>;
    splitImage(input: { nodeId: string; params: CanvasImageSplitParams; beforeCommit: () => Promise<void> }): Promise<CanvasAgentMediaOperationResult>;
    upscaleImage(input: { nodeId: string; params: CanvasImageUpscaleParams; beforeCommit: () => Promise<void> }): Promise<CanvasAgentMediaOperationResult>;
    extractVideoFrames(input: { nodeId: string; params: CanvasVideoFrameParams; beforeCommit: () => Promise<void> }): Promise<CanvasAgentMediaOperationResult>;
    extractVideoAudio(input: { nodeId: string; startMs: number; endMs: number; beforeCommit: () => Promise<void> }): Promise<CanvasAgentMediaOperationResult>;
    trimVideo(input: { nodeId: string; segments: Array<{ startMs: number; endMs: number }>; beforeCommit: () => Promise<void> }): Promise<CanvasAgentMediaOperationResult>;
};
