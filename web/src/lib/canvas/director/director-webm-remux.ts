import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { nanoid } from "nanoid";

const REMUX_TIMEOUT_MS = 90_000;
const MAX_INPUT_BYTES = 80 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

type FFmpegFactory = () => Promise<FFmpeg>;

async function createDirectorFFmpeg(): Promise<FFmpeg> {
    const [{ FFmpeg: FFmpegCtor }, coreModule, wasmModule] = await Promise.all([
        import("@ffmpeg/ffmpeg"),
        import("@ffmpeg/core?url"),
        import("@ffmpeg/core/wasm?url"),
    ]);
    const ffmpeg = new FFmpegCtor();
    try {
        await ffmpeg.load({ coreURL: coreModule.default, wasmURL: wasmModule.default });
        return ffmpeg;
    } catch (cause) {
        ffmpeg.terminate();
        throw new Error("导演视频封装工具加载失败", { cause });
    }
}

/**
 * ffmpeg.wasm 无重编码重封装 MediaRecorder WebM，为容器补上可供 ffprobe 读取的时长头。
 * 每次独立创建 worker 并使用随机文件名，避免与其他 FFmpeg 导出共享 VFS/命令状态。
 */
export function remuxDirectorWebm(blob: Blob): Promise<Blob> {
    return remuxDirectorWebmWithFactory(blob, createDirectorFFmpeg);
}

/** Worker factory 单独暴露给单元测试，生产调用固定使用同源 FFmpeg WASM。 */
export async function remuxDirectorWebmWithFactory(blob: Blob, createFFmpeg: FFmpegFactory, timeoutMs = REMUX_TIMEOUT_MS): Promise<Blob> {
    if (blob.type && !blob.type.toLowerCase().startsWith("video/webm")) throw new Error("导演录制只接受 WebM 视频");
    if (blob.size < 1 || blob.size > MAX_INPUT_BYTES) throw new Error("导演 WebM 文件为空或超过 80 MB 封装上限");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("WebM 封装超时时限无效");

    const id = nanoid();
    const inputName = `director-remux-${id}-input.webm`;
    const outputName = `director-remux-${id}-output.webm`;
    const ffmpegRef: { current: FFmpeg | null } = { current: null };
    let timedOut = false;
    let terminated = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const terminate = () => {
        if (terminated || !ffmpegRef.current) return;
        terminated = true;
        ffmpegRef.current.terminate();
    };

    const operation = (async () => {
        ffmpegRef.current = await createFFmpeg();
        if (timedOut) {
            terminate();
            throw new Error("导演 WebM 封装超时");
        }
        await ffmpegRef.current.writeFile(inputName, new Uint8Array(await blob.arrayBuffer()));
        const exitCode = await ffmpegRef.current.exec(["-hide_banner", "-loglevel", "error", "-y", "-i", inputName, "-map", "0", "-c", "copy", outputName]);
        if (exitCode !== 0) throw new Error(`导演 WebM 无损封装失败（ffmpeg exit ${exitCode}）`);
        const output = await ffmpegRef.current.readFile(outputName);
        if (typeof output === "string" || output.byteLength < 1 || output.byteLength > MAX_OUTPUT_BYTES) throw new Error("导演 WebM 封装输出为空或超过 100 MB 上限");
        return new Blob([output as BlobPart], { type: "video/webm" });
    })();

    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            terminate();
            reject(new Error(`导演 WebM 无损封装超过 ${Math.round(timeoutMs / 1000)} 秒，已中止`));
        }, timeoutMs);
    });

    try {
        return await Promise.race([operation, timeout]);
    } finally {
        if (timer !== null) clearTimeout(timer);
        const ffmpeg = ffmpegRef.current;
        if (ffmpeg) {
            if (!timedOut) await Promise.all([inputName, outputName].map((name) => ffmpeg.deleteFile(name).catch(() => undefined)));
            terminate();
        }
    }
}
