import { resourceFileUrl, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import type { ReferenceImage } from "@/types/image";

/** 调色参数，单位与 CSS filter 一致（百分比 / 度） */
export type CanvasColorGrade = {
    brightness: number;
    contrast: number;
    saturate: number;
    hueRotate: number;
};

export const DEFAULT_COLOR_GRADE: CanvasColorGrade = { brightness: 100, contrast: 100, saturate: 100, hueRotate: 0 };

export function isNeutralColorGrade(grade: CanvasColorGrade) {
    return grade.brightness === 100 && grade.contrast === 100 && grade.saturate === 100 && grade.hueRotate === 0;
}

/**
 * 预览（img 的 CSS filter）与导出（canvas 的 ctx.filter）共用同一个字符串。
 * 两处各写一份的话，用户看到的和生成用的就会悄悄不一致。
 */
export function colorGradeCssFilter(grade: CanvasColorGrade) {
    return `brightness(${grade.brightness}%) contrast(${grade.contrast}%) saturate(${grade.saturate}%) hue-rotate(${grade.hueRotate}deg)`;
}

// 同一张图 + 同一组参数在一次会话内只上传一次。
// 不做跨会话缓存：那需要往节点 metadata 回写，而构建参考图的路径拿不到写入通道。
const publishedCache = new Map<string, { url: string; storageKey: string; type: string }>();

function cacheKey(url: string, grade: CanvasColorGrade) {
    return `${url}|${grade.brightness}|${grade.contrast}|${grade.saturate}|${grade.hueRotate}`;
}

export type CanvasColorGradeRenderRuntime = {
    loadImage: (url: string) => Promise<HTMLImageElement>;
    createCanvas: () => HTMLCanvasElement;
};

const browserColorGradeRenderRuntime: CanvasColorGradeRenderRuntime = {
    loadImage: (url) => new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("源图无法读取（可能不允许跨域）"));
        image.src = url;
    }),
    createCanvas: () => document.createElement("canvas"),
};

function validateCanvasColorGrade(grade: CanvasColorGrade) {
    if (!grade || !Number.isFinite(grade.brightness) || grade.brightness < 0 || grade.brightness > 200
        || !Number.isFinite(grade.contrast) || grade.contrast < 0 || grade.contrast > 200
        || !Number.isFinite(grade.saturate) || grade.saturate < 0 || grade.saturate > 200
        || !Number.isFinite(grade.hueRotate) || grade.hueRotate < -180 || grade.hueRotate > 180) {
        throw new Error("调色参数超出允许范围");
    }
}

/** Render the same PNG pixels shown by the color-grade node preview, without uploading or generating. */
export async function renderCanvasColorGradePng(
    url: string,
    grade: CanvasColorGrade,
    runtime: CanvasColorGradeRenderRuntime = browserColorGradeRenderRuntime,
): Promise<{ dataUrl: string; width: number; height: number }> {
    if (typeof url !== "string" || !url.trim()) throw new Error("调色节点缺少可读源图");
    validateCanvasColorGrade(grade);
    const image = await runtime.loadImage(url);
    if (!Number.isFinite(image.naturalWidth) || image.naturalWidth < 1 || !Number.isFinite(image.naturalHeight) || image.naturalHeight < 1) {
        throw new Error("源图尺寸无效，无法导出调色结果");
    }
    const canvas = runtime.createCanvas();
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布上下文");
    // ctx.filter 在少数浏览器上不存在——那会静默导出一张未调色的图，
    // 与用户看到的预览不一致。宁可明确失败。
    if (!("filter" in ctx)) throw new Error("当前浏览器不支持导出调色结果，请换用 Chrome / Edge");
    ctx.filter = colorGradeCssFilter(grade);
    ctx.drawImage(image, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    if (!dataUrl.startsWith("data:image/png;base64,")) throw new Error("调色结果未能导出为 PNG");
    return { dataUrl, width: canvas.width, height: canvas.height };
}

function blobFromPngDataUrl(dataUrl: string): Blob {
    const encoded = dataUrl.slice("data:image/png;base64,".length);
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: "image/png" });
}

/**
 * 把调色节点的参考图落地成真实资源——照 resolveCanvasDrawingReference 的做法：
 * 本地渲染 → 上传 → 换成 storageKey/url，让下游按普通图片消费。
 *
 * 只在生成真正要用它时才调用（见 canvas-node-generation），所以拖滑杆调参数不会产生上传。
 */
export async function resolveCanvasColorGradeReference(image: ReferenceImage): Promise<ReferenceImage> {
    const source = image.source;
    if (!source || source.kind !== "colorgrade") return image;

    const cached = publishedCache.get(cacheKey(source.url, source.grade));
    if (cached) return { ...image, dataUrl: "", url: cached.url, storageKey: cached.storageKey, type: cached.type };

    try {
        const render = await renderCanvasColorGradePng(source.url, source.grade);
        const resource = await uploadResourceFile(blobFromPngDataUrl(render.dataUrl), "image", {
            width: render.width,
            height: render.height,
            fileName: `colorgrade-${image.id}.png`,
        });
        const storageKey = resourceStorageKey(resource.id);
        const url = resource.publicUrl || resourceFileUrl(resource.id);
        const type = resource.mimeType || "image/png";
        publishedCache.set(cacheKey(source.url, source.grade), { url, storageKey, type });
        return { ...image, dataUrl: "", url, storageKey, type };
    } catch (error) {
        throw new Error(error instanceof Error ? `调色参考图生成失败：${error.message}` : "调色参考图生成失败");
    }
}
