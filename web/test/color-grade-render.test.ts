import { describe, expect, test } from "bun:test";

import { renderCanvasColorGradePng, type CanvasColorGrade, type CanvasColorGradeRenderRuntime } from "../src/lib/canvas/canvas-color-grade";

const grade: CanvasColorGrade = { brightness: 125, contrast: 88, saturate: 140, hueRotate: -24 };

function runtime(options: { width?: number; height?: number; filterSupported?: boolean; dataUrl?: string } = {}) {
    let renderedFilter: string | undefined;
    let drawn = false;
    let requestedType = "";
    let canvasSize = { width: 0, height: 0 };
    const context = {
        ...(options.filterSupported === false ? {} : { filter: "none" }),
        drawImage: () => { drawn = true; },
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => context,
        toDataURL: (type: string) => {
            requestedType = type;
            canvasSize = { width: canvas.width, height: canvas.height };
            renderedFilter = (context as CanvasRenderingContext2D).filter;
            return options.dataUrl || "data:image/png;base64,cG5n";
        },
    } as unknown as HTMLCanvasElement;
    const image = { naturalWidth: options.width ?? 640, naturalHeight: options.height ?? 360 } as HTMLImageElement;
    const renderRuntime: CanvasColorGradeRenderRuntime = {
        loadImage: async (url) => {
            expect(url).toBe("source-image");
            return image;
        },
        createCanvas: () => canvas,
    };
    return {
        renderRuntime,
        read: () => ({ drawn, requestedType, renderedFilter, canvasSize }),
    };
}

describe("color-grade PNG renderer", () => {
    test("uses the preview CSS filter, source resolution, and PNG output", async () => {
        const fake = runtime();
        const result = await renderCanvasColorGradePng("source-image", grade, fake.renderRuntime);

        expect(result).toEqual({ dataUrl: "data:image/png;base64,cG5n", width: 640, height: 360 });
        expect(fake.read()).toEqual({
            drawn: true,
            requestedType: "image/png",
            renderedFilter: "brightness(125%) contrast(88%) saturate(140%) hue-rotate(-24deg)",
            canvasSize: { width: 640, height: 360 },
        });
    });

    test("rejects missing input, invalid parameters, unsupported filter, and empty export", async () => {
        const fake = runtime();
        await expect(renderCanvasColorGradePng("", grade, fake.renderRuntime)).rejects.toThrow("缺少可读源图");
        await expect(renderCanvasColorGradePng("source-image", { ...grade, brightness: 201 }, fake.renderRuntime)).rejects.toThrow("调色参数超出允许范围");
        await expect(renderCanvasColorGradePng("source-image", grade, runtime({ filterSupported: false }).renderRuntime)).rejects.toThrow("不支持导出调色结果");
        await expect(renderCanvasColorGradePng("source-image", grade, runtime({ width: 0 }).renderRuntime)).rejects.toThrow("源图尺寸无效");
        await expect(renderCanvasColorGradePng("source-image", grade, runtime({ dataUrl: "data:image/jpeg;base64,eA==" }).renderRuntime)).rejects.toThrow("未能导出为 PNG");
    });
});
