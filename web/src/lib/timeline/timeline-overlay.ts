import type { TimelineClip, TimelineOverlayRect } from "@/types/timeline";

export type OverlayCanvasImage = CanvasImageSource & { width: number; height: number };

export function timelineOverlayRect(clip: TimelineClip): TimelineOverlayRect {
    const rect = clip.overlay ?? (clip.kind === "image"
        ? { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }
        : { x: 0.05, y: 0.72, width: 0.9, height: 0.22 });
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > 1 || rect.y + rect.height > 1) {
        throw new Error(`片段 ${clip.id} 的 overlay 坐标必须在 0 到 1 之间，且矩形不得越出画面`);
    }
    return rect;
}

/** Shared raster semantics for preview and MP4 export. Coordinates are normalized to the video frame. */
export function drawTimelineOverlay(ctx: CanvasRenderingContext2D, clip: TimelineClip, width: number, height: number, image?: OverlayCanvasImage) {
    if (clip.kind === "subtitle") {
        const text = clip.text?.trim() || "";
        if (!text) return;
        const fontSize = Math.max(12, Math.min(64, Math.round(height * 0.065)));
        ctx.font = `600 ${fontSize}px Arial, "Microsoft YaHei", sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const maxWidth = width * 0.9;
        const lines = wrapText(ctx, text.replace(/\r?\n/g, " "), maxWidth);
        const lineHeight = fontSize * 1.25;
        const y0 = height - Math.max(fontSize * 1.2, height * 0.08) - lineHeight * (lines.length - 1) / 2;
        lines.forEach((line, index) => {
            const y = y0 + index * lineHeight;
            ctx.lineJoin = "round"; ctx.lineWidth = Math.max(2, fontSize * 0.18);
            ctx.strokeStyle = "rgba(0,0,0,0.9)"; ctx.strokeText(line, width / 2, y, maxWidth);
            ctx.fillStyle = "#fff"; ctx.fillText(line, width / 2, y, maxWidth);
        });
        return;
    }
    const rect = timelineOverlayRect(clip);
    const x = rect.x * width, y = rect.y * height, boxWidth = rect.width * width, boxHeight = rect.height * height;
    if (clip.kind === "image") {
        if (!image || image.width <= 0 || image.height <= 0) throw new Error(`图片片段 ${clip.id} 无法解码`);
        const scale = Math.min(boxWidth / image.width, boxHeight / image.height);
        const drawWidth = image.width * scale, drawHeight = image.height * scale;
        ctx.drawImage(image, x + (boxWidth - drawWidth) / 2, y + (boxHeight - drawHeight) / 2, drawWidth, drawHeight);
        return;
    }
    if (clip.kind !== "text") return;
    const text = clip.text ?? clip.directMedia?.content ?? clip.directMedia?.dataUrl ?? "";
    if (!text.trim()) throw new Error(`文字片段 ${clip.id} 缺少文本内容`);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(x, y, boxWidth, boxHeight);
    const fontSize = Math.max(12, Math.round(boxHeight * 0.22));
    ctx.font = `600 ${fontSize}px Arial, "Microsoft YaHei", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const inset = Math.min(fontSize, boxWidth * 0.04);
    const maxWidth = Math.max(1, boxWidth - inset * 2);
    const lines = wrapText(ctx, text, maxWidth);
    const lineHeight = fontSize * 1.2;
    const visibleLines = Math.max(1, Math.floor((boxHeight - fontSize * 0.4) / lineHeight));
    const shown = lines.slice(0, visibleLines);
    const firstY = y + boxHeight / 2 - ((shown.length - 1) * lineHeight) / 2;
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(2, fontSize * 0.16);
    ctx.strokeStyle = "rgba(0,0,0,0.95)";
    ctx.fillStyle = "#ffffff";
    shown.forEach((line, index) => {
        const clipped = index === visibleLines - 1 && lines.length > visibleLines ? `${line.slice(0, -1)}…` : line;
        const lineY = firstY + index * lineHeight;
        ctx.strokeText(clipped, x + boxWidth / 2, lineY, maxWidth);
        ctx.fillText(clipped, x + boxWidth / 2, lineY, maxWidth);
    });
}

export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
    const lines: string[] = [];
    for (const paragraph of text.replace(/\r/g, "").split("\n")) {
        let line = "";
        for (const char of paragraph) {
            const next = line + char;
            if (line && ctx.measureText(next).width > maxWidth) { lines.push(line); line = char; }
            else line = next;
        }
        lines.push(line);
    }
    return lines;
}

export async function rasterizeTimelineOverlay(clip: TimelineClip, width: number, height: number, image?: OverlayCanvasImage) {
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建时间线 overlay 画布");
    drawTimelineOverlay(ctx, clip, width, height, image);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("时间线 overlay PNG 编码失败")), "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
}
