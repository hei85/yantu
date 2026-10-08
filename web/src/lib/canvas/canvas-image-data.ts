export type ImageCropRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type ImageAngleTransform = {
    horizontalAngle: number;
    pitchAngle: number;
    cameraDistance: number;
    wideAngle: boolean;
};

export type ImageUpscaleAlgorithm = "nearest" | "bilinear" | "high";

export const MAX_UPSCALE_LONG_EDGE = 4096;

export type ImageUpscaleParams = {
    targetLongEdge: number;
    algorithm: ImageUpscaleAlgorithm;
};

export type ImageSplitParams = {
    rows: number;
    columns: number;
};

export type ImageSplitPiece = {
    row: number;
    column: number;
    dataUrl: string;
};

export async function cropDataUrl(dataUrl: string, crop?: ImageCropRect) {
    const image = await loadImage(dataUrl);
    if (crop) {
        return drawCrop(image, Math.floor(crop.x * image.width), Math.floor(crop.y * image.height), Math.ceil(crop.width * image.width), Math.ceil(crop.height * image.height));
    }
    const size = Math.min(image.width, image.height);
    const sx = Math.max(0, Math.floor((image.width - size) / 2));
    const sy = Math.max(0, Math.floor((image.height - size) / 2));
    return drawCrop(image, sx, sy, size, size);
}

export async function splitDataUrl(dataUrl: string, params: ImageSplitParams): Promise<ImageSplitPiece[]> {
    const image = await loadImage(dataUrl);
    const rows = Math.max(1, Math.floor(params.rows));
    const columns = Math.max(1, Math.floor(params.columns));
    const pieces: ImageSplitPiece[] = [];
    // Generated contact sheets can contain separator pixels inside equal cells.
    // Remove thin divider runs (including antialiased dark lines); never pad a crop.
    const probe = document.createElement("canvas");
    probe.width = image.width;
    probe.height = image.height;
    const probeContext = probe.getContext("2d", { willReadFrequently: true });
    if (!probeContext) throw new Error("无法读取宫格图片像素");
    probeContext.drawImage(image, 0, 0);
    const pixels = probeContext.getImageData(0, 0, image.width, image.height).data;
    const isSeparator = (x: number, y: number, allowBlack = false) => {
        const i = (y * image.width + x) * 4;
        return pixels[i + 3] < 8 || (pixels[i] >= 235 && pixels[i + 1] >= 235 && pixels[i + 2] >= 235)
            || (allowBlack && pixels[i] <= 32 && pixels[i + 1] <= 32 && pixels[i + 2] <= 32);
    };
    const neutralLineCache = new Map<string, boolean>();
    const isNeutralGridLine = (axis: "x" | "y", position: number) => {
        const key = `${axis}:${position}`;
        const cached = neutralLineCache.get(key);
        if (cached !== undefined) return cached;
        const extent = axis === "x" ? image.width : image.height;
        const length = axis === "x" ? image.height : image.width;
        if (position < 2 || position >= extent - 2) return false;
        let neutral = 0, total = 0, before = 0, after = 0;
        for (let offset = 0; offset < length; offset++) {
            const index = (p: number) => ((axis === "x" ? offset * image.width + p : p * image.width + offset) * 4);
            const i = index(position), a = index(position - 2), b = index(position + 2);
            const low = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
            const high = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
            if (low >= 110 && high - low <= 24) neutral++;
            total += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
            before += (pixels[a] + pixels[a + 1] + pixels[a + 2]) / 3;
            after += (pixels[b] + pixels[b + 1] + pixels[b + 2]) / 3;
        }
        // Generated separators can be gray after antialiasing. Require a thin,
        // bright, neutral line across the whole grid, brighter than both sides;
        // a naturally pale wall without this local contrast is retained.
        const result = neutral / length >= 0.98 && total / length > Math.max(before, after) / length + 25;
        neutralLineCache.set(key, result);
        return result;
    };

    for (let row = 0; row < rows; row += 1) {
        const sy = Math.floor((row * image.height) / rows);
        const sh = Math.floor(((row + 1) * image.height) / rows) - sy;
        for (let column = 0; column < columns; column += 1) {
            const sx = Math.floor((column * image.width) / columns);
            const sw = Math.floor(((column + 1) * image.width) / columns) - sx;
            let left = sx, top = sy, right = sx + sw, bottom = sy + sh;
            const maxX = Math.max(1, Math.floor(sw * 0.03));
            const maxY = Math.max(1, Math.floor(sh * 0.03));
            const columnIsBorder = (x: number, allowBlack: boolean) => {
                if (allowBlack && isNeutralGridLine("x", x)) return true;
                let count = 0;
                for (let y = top; y < bottom; y++) if (isSeparator(x, y, allowBlack)) count++;
                return count / (bottom - top) >= (allowBlack ? 0.98 : 0.995);
            };
            const rowIsBorder = (y: number, allowBlack: boolean) => {
                if (allowBlack && isNeutralGridLine("y", y)) return true;
                let count = 0;
                for (let x = left; x < right; x++) if (isSeparator(x, y, allowBlack)) count++;
                return count / (right - left) >= (allowBlack ? 0.98 : 0.995);
            };
            // Separator placement is approximate, not necessarily the exact midpoint.
            // Search a narrow boundary neighborhood before stripping the edge run.
            // A dark core can fall one pixel outside this cell, with its antialias
            // fringe inside; detect the adjacent pixel before searching inward.
            if (column > 0 && columnIsBorder(sx - 1, true)) left = sx + 1;
            if (column < columns - 1 && columnIsBorder(sx + sw, true)) right = sx + sw - 1;
            if (row > 0 && rowIsBorder(sy - 1, true)) top = sy + 1;
            if (row < rows - 1 && rowIsBorder(sy + sh, true)) bottom = sy + sh - 1;
            if (column > 0) for (let x = sx; x < sx + maxX; x++) {
                if (columnIsBorder(x, true)) left = x + 1;
            }
            if (column < columns - 1) for (let x = sx + sw - 1; x >= sx + sw - maxX; x--) {
                if (columnIsBorder(x, true)) right = x;
            }
            if (row > 0) for (let y = sy; y < sy + maxY; y++) {
                if (rowIsBorder(y, true)) top = y + 1;
            }
            if (row < rows - 1) for (let y = sy + sh - 1; y >= sy + sh - maxY; y--) {
                if (rowIsBorder(y, true)) bottom = y;
            }
            while (left - sx < maxX && left < right - 1 && columnIsBorder(left, column > 0)) left++;
            while (sx + sw - right < maxX && right > left + 1 && columnIsBorder(right - 1, column < columns - 1)) right--;
            while (top - sy < maxY && top < bottom - 1 && rowIsBorder(top, row > 0)) top++;
            while (sy + sh - bottom < maxY && bottom > top + 1 && rowIsBorder(bottom - 1, row < rows - 1)) bottom--;
            // Exclude the two-pixel antialias halo around an identified separator.
            if (left > sx) left = Math.min(right - 1, left + 2);
            if (right < sx + sw) right = Math.max(left + 1, right - 2);
            if (top > sy) top = Math.min(bottom - 1, top + 2);
            if (bottom < sy + sh) bottom = Math.max(top + 1, bottom - 2);
            pieces.push({ row, column, dataUrl: drawCrop(image, left, top, right - left, bottom - top) });
        }
    }

    return pieces;
}

export async function transformAngleDataUrl(dataUrl: string, params: ImageAngleTransform) {
    const image = await loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    const padding = Math.round(Math.max(image.width, image.height) * 0.18);
    canvas.width = image.width + padding * 2;
    canvas.height = image.height + padding * 2;
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    context.clearRect(0, 0, canvas.width, canvas.height);

    const horizontal = params.horizontalAngle / 60;
    const pitch = params.pitchAngle / 45;
    const distanceScale = 1.12 - params.cameraDistance * 0.035;
    const wideScale = params.wideAngle ? 0.88 : 1;
    const scale = Math.max(0.64, Math.min(1.1, distanceScale * wideScale));
    const width = image.width * scale * (1 - Math.abs(horizontal) * 0.28);
    const height = image.height * scale * (1 - Math.abs(pitch) * 0.18);
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const skewX = horizontal * image.width * 0.18;
    const skewY = pitch * image.height * 0.12;
    const x = cx - width / 2 + horizontal * padding * 0.5;
    const y = cy - height / 2 + pitch * padding * 0.45;

    context.save();
    context.setTransform(1, pitch * 0.08, horizontal * -0.1, 1, 0, 0);
    context.drawImage(image, x + skewX, y + skewY, width, height);
    context.restore();

    if (params.wideAngle) {
        const gradient = context.createRadialGradient(cx, cy, Math.min(canvas.width, canvas.height) * 0.2, cx, cy, Math.max(canvas.width, canvas.height) * 0.62);
        gradient.addColorStop(0, "rgba(255,255,255,0)");
        gradient.addColorStop(1, "rgba(0,0,0,0.18)");
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
    }

    return canvas.toDataURL("image/png");
}

export async function upscaleDataUrl(dataUrl: string, params: ImageUpscaleParams) {
    const image = await loadImage(dataUrl);
    const { width, height } = resolveUpscaleSize(image.width, image.height, params.targetLongEdge);
    return params.algorithm === "high" ? drawStepUpscale(image, width, height) : drawResize(image, image.width, image.height, width, height, params.algorithm);
}

export function resolveUpscaleSize(width: number, height: number, targetLongEdge: number) {
    const longEdge = Math.max(1, width, height);
    const target = Math.min(MAX_UPSCALE_LONG_EDGE, Math.max(1, Math.round(targetLongEdge)));
    const scale = target / longEdge;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function drawCrop(image: HTMLImageElement, sx: number, sy: number, sw: number, sh: number) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, sw);
    canvas.height = Math.max(1, sh);
    const context = canvas.getContext("2d");
    if (!context) return image.src;
    context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
}

function drawStepUpscale(image: HTMLImageElement, width: number, height: number) {
    let source: CanvasImageSource = image;
    let sourceWidth = image.width;
    let sourceHeight = image.height;

    while (sourceWidth * 2 < width && sourceHeight * 2 < height) {
        const nextWidth = sourceWidth * 2;
        const nextHeight = sourceHeight * 2;
        const next = drawResizeCanvas(source, sourceWidth, sourceHeight, nextWidth, nextHeight, "high");
        source = next;
        sourceWidth = nextWidth;
        sourceHeight = nextHeight;
    }

    return drawResize(source, sourceWidth, sourceHeight, width, height, "high");
}

function drawResize(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, algorithm: ImageUpscaleAlgorithm) {
    return drawResizeCanvas(source, sourceWidth, sourceHeight, width, height, algorithm).toDataURL("image/png");
}

function drawResizeCanvas(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, algorithm: ImageUpscaleAlgorithm) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return canvas;
    context.imageSmoothingEnabled = algorithm !== "nearest";
    context.imageSmoothingQuality = algorithm === "bilinear" ? "medium" : "high";
    context.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
    return canvas;
}

function loadImage(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.src = dataUrl;
    });
}
