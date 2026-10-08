import { createShapeId, createTLStore, getIndexAbove, loadSnapshot, toRichText } from "tldraw";
import type { TLGeoShape, TLShape, TLStoreSnapshot } from "tldraw";

const MAX_SIZE = 4000;
const MAX_TEXT_LENGTH = 2000;
const COLORS = new Set(["black", "grey", "light-blue", "blue", "yellow", "orange", "green", "light-green", "light-violet", "violet", "light-red", "red", "white"]);
const FILLS = new Set(["none", "semi", "solid", "pattern"]);

type PositionAndSize = { x?: number; y?: number; w?: number; h?: number; rotation?: number; color?: string };
export type TldrawDrawingOperation =
    | ({ type: "add_shape"; shapeType: "rectangle" | "ellipse"; fill?: string } & Required<Pick<PositionAndSize, "x" | "y" | "w" | "h">> & Pick<PositionAndSize, "color">)
    | ({ type: "add_shape"; shapeType: "text"; text: string } & Required<Pick<PositionAndSize, "x" | "y">> & Pick<PositionAndSize, "w" | "color">)
    | ({ type: "update_element"; shapeId: string } & PositionAndSize & { text?: string; fill?: string })
    | { type: "delete_element"; shapeId: string };

export type TldrawDrawingOperationResult = {
    snapshot: unknown;
    shapeId: string | null;
    shapeCount: number;
};

function validNumber(value: unknown, label: string, min = -100_000, max = 100_000): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} 超出允许范围`);
    return value;
}

function validateText(value: unknown) {
    if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT_LENGTH) throw new Error("文字必须为 1 到 2000 个字符");
    return value;
}

function validateColor(value: unknown): TLGeoShape["props"]["color"] {
    if (typeof value !== "string" || !COLORS.has(value)) throw new Error("不支持的 tldraw 颜色");
    return value as TLGeoShape["props"]["color"];
}

function validateFill(value: unknown): TLGeoShape["props"]["fill"] {
    if (typeof value !== "string" || !FILLS.has(value)) throw new Error("不支持的填充样式");
    return value as TLGeoShape["props"]["fill"];
}

function openOnePageStore(snapshot: unknown) {
    if (!snapshot || typeof snapshot !== "object" || (!("document" in snapshot) && !("store" in snapshot))) throw new Error("无效的 tldraw snapshot");
    const store = createTLStore();
    loadSnapshot(store, snapshot as unknown as TLStoreSnapshot);
    const pages = store.allRecords().filter((record) => record.typeName === "page");
    if (pages.length !== 1) throw new Error("绘图文档必须恰好包含一个页面");
    return { store, pageId: pages[0].id, session: "session" in snapshot ? snapshot.session : undefined };
}

function shapeCount(store: ReturnType<typeof createTLStore>, pageId: string) {
    return store.allRecords().filter((record): record is TLShape => record.typeName === "shape" && record.parentId === pageId).length;
}

/** Apply one narrowly-scoped MCP drawing mutation to a valid single-page tldraw snapshot. */
export function applyTldrawDrawingOperation(snapshot: unknown, operation: TldrawDrawingOperation): TldrawDrawingOperationResult {
    const { store, pageId, session } = openOnePageStore(snapshot);
    let shapeId: string | null = null;

    if (operation.type === "add_shape") {
        const id = createShapeId();
        const x = validNumber(operation.x, "x");
        const y = validNumber(operation.y, "y");
        const color = validateColor(operation.color ?? "black");
        const siblings = store.allRecords().filter((record): record is TLShape => record.typeName === "shape" && record.parentId === pageId);
        const topIndex = siblings.reduce<TLShape["index"]>((index, shape) => shape.index > index ? shape.index : index, "a0" as TLShape["index"]);
        const nextIndex = getIndexAbove(topIndex);
        if (operation.shapeType === "text") {
            const w = validNumber(operation.w ?? 240, "宽度", 20, MAX_SIZE);
            store.put([{ id, typeName: "shape", type: "text", parentId: pageId, index: nextIndex, x, y, rotation: 0, isLocked: false, opacity: 1, props: { color, size: "m", font: "sans", textAlign: "start", w, richText: toRichText(validateText(operation.text)), scale: 1, autoSize: true }, meta: {} }]);
        } else {
            const w = validNumber(operation.w, "宽度", 1, MAX_SIZE);
            const h = validNumber(operation.h, "高度", 1, MAX_SIZE);
            const geo = operation.shapeType === "rectangle" ? "rectangle" : "ellipse";
            const shape: TLGeoShape = { id, typeName: "shape", type: "geo", parentId: pageId, index: nextIndex, x, y, rotation: 0, isLocked: false, opacity: 1, props: { geo, dash: "draw", url: "", w, h, growY: 0, scale: 1, labelColor: "black", color, fill: validateFill(operation.fill ?? "semi"), size: "m", font: "sans", align: "middle", verticalAlign: "middle", richText: toRichText("") }, meta: {} };
            store.put([shape]);
        }
        shapeId = id;
    } else {
        if (!/^shape:[a-zA-Z0-9_-]+$/.test(operation.shapeId)) throw new Error("无效的 shape ID");
        const shape = store.get(operation.shapeId as TLShape["id"]);
        if (!shape || shape.typeName !== "shape" || shape.parentId !== pageId) throw new Error("shape ID 不存在于当前页面");
        shapeId = shape.id;
        if (operation.type === "delete_element") store.remove([shape.id]);
        else {
            const patch: Record<string, unknown> = {};
            for (const key of ["x", "y", "rotation"] as const) if (operation[key] !== undefined) patch[key] = validNumber(operation[key], key, key === "rotation" ? -360 : -100_000, key === "rotation" ? 360 : 100_000);
            const props: Record<string, unknown> = {};
            if (operation.color !== undefined) props.color = validateColor(operation.color);
            if (operation.text !== undefined) {
                if (shape.type !== "text" && shape.type !== "geo") throw new Error("此形状不支持文字");
                props.richText = toRichText(validateText(operation.text));
            }
            if (operation.fill !== undefined) {
                if (shape.type !== "geo") throw new Error("此形状不支持填充");
                props.fill = validateFill(operation.fill);
            }
            for (const key of ["w", "h"] as const) if (operation[key] !== undefined) {
                const dimension = validNumber(operation[key], key, 1, MAX_SIZE);
                if (shape.type === "text" && key === "h") throw new Error("文字形状不支持设置高度");
                props[key] = dimension;
            }
            if (Object.keys(props).length) patch.props = { ...shape.props, ...props };
            store.put([{ ...shape, ...patch } as TLShape]);
        }
    }

    const document = store.getStoreSnapshot();
    return { snapshot: session ? { document, session } : document, shapeId, shapeCount: shapeCount(store, pageId) };
}
