import type { ImageToolMark, ImageToolRect } from "@/pages/canvas/canvas-agent-image-operations";

export function validateImageToolRect(rect: ImageToolRect) {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > 1.000001 || rect.y + rect.height > 1.000001) throw new Error("区域必须位于原图内，使用 0–1 归一化坐标");
}

export async function imageCanvas(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`读取图片失败：HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob());
    if (bitmap.width * bitmap.height > 36_000_000) { bitmap.close(); throw new Error("本地标注/蒙版最多支持 3600 万像素，请先调整尺寸"); }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) { bitmap.close(); throw new Error("浏览器无法创建图片处理画布"); }
    context.drawImage(bitmap, 0, 0); bitmap.close();
    return { canvas, context };
}

export async function renderImageToolAnnotations(url: string, marks: ImageToolMark[]) {
    if (!marks.length || marks.length > 100) throw new Error("标注数量须在 1–100 之间");
    const { canvas, context: ctx } = await imageCanvas(url);
    for (const mark of marks) {
        if (![mark.x, mark.y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error("标注坐标须位于原图内");
        const x = mark.x * canvas.width, y = mark.y * canvas.height;
        const width = (mark.width || 0) * canvas.width, height = (mark.height || 0) * canvas.height;
        ctx.strokeStyle = mark.color || "#ff3b30"; ctx.fillStyle = mark.color || "#ff3b30";
        ctx.lineWidth = mark.strokeWidth || 4; ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.beginPath();
        if (mark.type === "rectangle" || mark.type === "ellipse") {
            validateImageToolRect({ x: mark.x, y: mark.y, width: mark.width || 0, height: mark.height || 0 });
            if (mark.type === "rectangle") ctx.rect(x, y, width, height);
            else ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
            ctx.stroke();
        } else if (mark.type === "text") {
            if (!mark.text?.trim()) throw new Error("文字标注必须提供内容");
            ctx.font = `${mark.fontSize || 32}px sans-serif`; ctx.textBaseline = "top"; ctx.fillText(mark.text, x, y);
        } else {
            if (mark.x2 === undefined || mark.y2 === undefined || ![mark.x2, mark.y2].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error("线条/箭头需要终点坐标");
            const x2 = mark.x2 * canvas.width, y2 = mark.y2 * canvas.height;
            ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
            if (mark.type === "arrow") {
                const angle = Math.atan2(y2 - y, x2 - x), head = Math.max(12, ctx.lineWidth * 4);
                ctx.beginPath(); ctx.moveTo(x2, y2);
                ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
                ctx.moveTo(x2, y2); ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6)); ctx.stroke();
            }
        }
    }
    return canvas.toDataURL("image/png");
}

export async function inspectImageToolAlpha(url: string) {
    const { canvas, context } = await imageCanvas(url);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let transparent = 0, visible = 0;
    for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] < 250) transparent++; if (pixels[i] > 5) visible++; }
    return { width: canvas.width, height: canvas.height, transparentPixels: transparent, visiblePixels: visible, transparentFraction: transparent / (pixels.length / 4), usableAlpha: transparent > 0 && visible > 0 };
}

export async function regionMask(url: string, regions: ImageToolRect[]) {
    if (!regions.length) throw new Error("蒙版重绘必须提供实际蒙版或编辑区域");
    const { canvas, context } = await imageCanvas(url);
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
    regions.forEach((rect) => { validateImageToolRect(rect); context.clearRect(Math.floor(rect.x * canvas.width), Math.floor(rect.y * canvas.height), Math.ceil(rect.width * canvas.width), Math.ceil(rect.height * canvas.height)); });
    return canvas.toDataURL("image/png");
}
