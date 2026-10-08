import { captureVideoFrames } from "@/lib/canvas/canvas-video-frame";
import { getActiveUserScope } from "@/lib/user-scope";
import { runLocalCutoutEstimation } from "@/services/cutout-runtime";
import { runLocalDepthEstimation } from "@/services/depth-runtime";
import { runLocalLineartEstimation } from "@/services/lineart-runtime";
import { runLocalPoseEstimation } from "@/services/pose-runtime";

import { convertImageLocally } from "./local-converter";
import type { MediaConversionOperation } from "./contracts";

export async function executeMediaConversion(input: {
    sourceUrl: string;
    sourceKind: "image" | "video";
    operation: MediaConversionOperation;
    videoFrameTimeSeconds?: number;
    signal: AbortSignal;
}) {
    let frameUrl: string | undefined;
    try {
        let operationSourceUrl = input.sourceUrl;
        if (input.sourceKind === "video") {
            const timeMs = Math.round((input.videoFrameTimeSeconds ?? 0) * 1000);
            const capture = await captureVideoFrames(input.sourceUrl, [timeMs]);
            if (input.signal.aborted) throw new DOMException("转换已取消", "AbortError");
            const frame = capture.frames[0];
            if (!frame || Math.abs(frame.timeMs - timeMs) > 2) throw new Error("取帧时间超过视频时长，请选择视频范围内的时间");
            frameUrl = URL.createObjectURL(frame.blob);
            operationSourceUrl = frameUrl;
        }
        const result = input.operation === "cutout"
            ? await runLocalCutoutEstimation(operationSourceUrl, input.signal)
            : input.operation === "depth"
                ? await runLocalDepthEstimation(operationSourceUrl, input.signal)
                : input.operation === "lineart"
                    ? await runLocalLineartEstimation(operationSourceUrl, input.signal)
                : input.operation === "pose"
                    ? await runLocalPoseEstimation(operationSourceUrl, input.signal)
                : await convertImageLocally(operationSourceUrl, input.operation, { signal: input.signal, maxDimension: 1024 });
        return {
            blob: result.blob,
            width: result.width,
            height: result.height,
            detectedPeople: input.operation === "pose" && "personCount" in result && typeof result.personCount === "number" ? result.personCount : undefined,
        };
    } finally {
        if (frameUrl) URL.revokeObjectURL(frameUrl);
    }
}

export function localConversionStorageKey(nodeId: string, fingerprint: string, operation: MediaConversionOperation) {
    return `image:${getActiveUserScope()}:media-conversion:${nodeId}:${fingerprint}:${operation}`;
}
