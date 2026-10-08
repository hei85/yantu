export async function waitForDirectorCaptureReady<T>(readCapture: () => T | null, openWorkbench: () => void, isViewportReady: () => boolean = () => true, timeoutMs = 15000): Promise<T> {
    if (!readCapture()) openWorkbench();
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const capture = readCapture();
        if (capture && isViewportReady()) return capture;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("viewport_unavailable：导演工作台的真实 3D 视口未在时限内就绪");
}

export type DirectorCanvasSize = { width: number; height: number };

export function directorCanvasHasAspect(size: DirectorCanvasSize | null, aspect = 16 / 9, tolerance = 0.006) {
    if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width < 1 || size.height < 1) return false;
    return Math.abs(size.width / size.height - aspect) <= tolerance;
}

/** Waits for the actual WebGL drawing buffer, not a CSS class or requested view mode. */
export async function waitForDirectorCanvasAspect(readSize: () => DirectorCanvasSize | null, aspect = 16 / 9, timeoutMs = 5000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const size = readSize();
        if (directorCanvasHasAspect(size, aspect)) return size!;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("CAM 视口缓冲区未调整为 16:9，已拒绝生成非目标比例的导出");
}
