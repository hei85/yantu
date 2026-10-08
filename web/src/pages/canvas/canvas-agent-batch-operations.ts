import { batchReferenceColumns } from "@/lib/canvas/canvas-batch-table";
import { CanvasNodeType, type CanvasBatchRow, type CanvasBatchTableData, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export type CanvasBatchTableReadback = {
    nodeId: string;
    nodeUpdatedAt: string | null;
    table: CanvasBatchTableData;
};

export type CanvasBatchOperationReadback = CanvasBatchTableReadback & {
    changed: boolean;
    row?: CanvasBatchRow;
    removedRow?: CanvasBatchRow;
};

export type CanvasBatchTableNativeActions = {
    addReferenceColumn: (nodeId: string) => void;
    addRow: (nodeId: string) => void;
    moveReferenceCell: (nodeId: string, sourceRowId: string, sourceColumnIndex: number, targetRowId: string, targetColumnIndex: number) => void;
    removeReferenceColumn: (nodeId: string) => void;
    removeRow: (nodeId: string, rowId: string) => void;
    reorderReferenceColumns: (nodeId: string, fromColumnId: string, toColumnId: string) => void;
    syncRowsFromConnections: (nodeId: string, silent?: boolean) => boolean;
    updateRow: (nodeId: string, rowId: string, patch: Partial<CanvasBatchRow>) => void;
};

type CanvasBatchTableRefs = {
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
};

function readTable(refs: CanvasBatchTableRefs, nodeId: string): CanvasBatchTableReadback {
    if (!nodeId.trim()) throw new Error("nodeId 不能为空");
    const node = refs.nodesRef.current.find((item) => item.id === nodeId);
    if (!node) throw new Error(`画布节点不存在：${nodeId}`);
    if (node.type !== CanvasNodeType.BatchTable) throw new Error(`节点不是批量创作表：${nodeId}`);
    if (!node.metadata?.batchTable) throw new Error(`批量创作表数据缺失：${nodeId}`);
    return { nodeId, nodeUpdatedAt: node.updatedAt || null, table: structuredClone(node.metadata.batchTable) };
}

function requireRow(table: CanvasBatchTableData, rowId: string) {
    if (!rowId.trim()) throw new Error("rowId 不能为空");
    const matches = table.rows.filter((item) => item.id === rowId);
    if (matches.length !== 1) throw new Error(matches.length ? `rowId 不唯一：${rowId}` : `批量创作行不存在：${rowId}`);
    return matches[0];
}

function requireColumn(table: CanvasBatchTableData, columnId: string) {
    if (!columnId.trim()) throw new Error("columnId 不能为空");
    const matches = batchReferenceColumns(table).filter((column) => column.id === columnId);
    if (matches.length !== 1) throw new Error(matches.length ? `columnId 不唯一：${columnId}` : `参考列不存在：${columnId}`);
    return matches[0];
}

function requireColumnIndex(table: CanvasBatchTableData, index: number) {
    const count = batchReferenceColumns(table).length;
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`参考列索引越界：${index}（当前 ${count} 列）`);
}

function assertImageReferences(refs: CanvasBatchTableRefs, ids: string[]) {
    if (!Array.isArray(ids)) throw new Error("inputNodeIds 必须是数组");
    for (const id of ids) {
        if (!id) continue;
        const node = refs.nodesRef.current.find((item) => item.id === id);
        if (!node || node.type !== CanvasNodeType.Image || !(node.metadata?.content || node.metadata?.storageKey)) {
            throw new Error(`参考节点不是可用图片：${id}`);
        }
    }
}

export function createCanvasBatchAgentOperations(refs: CanvasBatchTableRefs, native: CanvasBatchTableNativeActions) {
    const current = (nodeId: string) => readTable(refs, nodeId);
    const read = (nodeId: string) => current(nodeId);
    const readRow = (nodeId: string, rowId: string) => {
        const result = current(nodeId);
        return { ...result, row: structuredClone(requireRow(result.table, rowId)) };
    };
    const finish = (nodeId: string, before: CanvasBatchTableData, rowId?: string, removedRow?: CanvasBatchRow): CanvasBatchOperationReadback => {
        const result = current(nodeId);
        const row = rowId ? result.table.rows.find((item) => item.id === rowId) : undefined;
        return { ...result, changed: JSON.stringify(before) !== JSON.stringify(result.table), ...(row ? { row: structuredClone(row) } : {}), ...(removedRow ? { removedRow: structuredClone(removedRow) } : {}) };
    };

    return {
        read,
        readRow,
        addRow(nodeId: string) {
            const before = current(nodeId).table;
            native.addRow(nodeId);
            const after = current(nodeId).table;
            const added = after.rows.find((row) => !before.rows.some((candidate) => candidate.id === row.id));
            if (!added) throw new Error("新增批量创作行未能写入状态");
            return finish(nodeId, before, added.id);
        },
        updateRow(nodeId: string, rowId: string, patch: Partial<CanvasBatchRow>) {
            const before = current(nodeId).table;
            const currentRow = requireRow(before, rowId);
            const allowed = new Set(["enabled", "inputNodeIds", "textNodeIds", "prompt"]);
            const unknown = Object.keys(patch).find((key) => !allowed.has(key));
            if (unknown) throw new Error(`不允许通过批量表接口修改行字段：${unknown}`);
            if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
            if (patch.prompt !== undefined && typeof patch.prompt !== "string") throw new Error("prompt 必须是字符串");
            if (patch.inputNodeIds !== undefined) {
                if (patch.inputNodeIds.length > batchReferenceColumns(before).length) throw new Error("参考图数量超过当前列数");
                assertImageReferences(refs, patch.inputNodeIds);
            }
            if (patch.textNodeIds !== undefined) {
                for (const id of patch.textNodeIds) {
                    const node = refs.nodesRef.current.find((item) => item.id === id);
                    if (!node || node.type !== CanvasNodeType.Text) throw new Error(`提示词节点无效：${id}`);
                }
            }
            native.updateRow(nodeId, rowId, { ...patch, id: currentRow.id });
            return finish(nodeId, before, rowId);
        },
        removeRow(nodeId: string, rowId: string) {
            const before = current(nodeId).table;
            const removedRow = structuredClone(requireRow(before, rowId));
            native.removeRow(nodeId, rowId);
            const result = finish(nodeId, before, undefined, removedRow);
            if (result.table.rows.some((row) => row.id === rowId)) throw new Error(`批量创作行删除未生效：${rowId}`);
            return result;
        },
        addReferenceColumn(nodeId: string) {
            const before = current(nodeId).table;
            if (batchReferenceColumns(before).length >= 6) throw new Error("参考列最多 6 列");
            native.addReferenceColumn(nodeId);
            return finish(nodeId, before);
        },
        removeReferenceColumn(nodeId: string, columnId: string) {
            const before = current(nodeId).table;
            const columns = batchReferenceColumns(before);
            const column = requireColumn(before, columnId);
            if (columns.length <= 1) throw new Error("至少保留 1 组参考图");
            const lastColumn = columns.at(-1)!;
            if (column.id !== lastColumn.id) native.reorderReferenceColumns(nodeId, column.id, lastColumn.id);
            native.removeReferenceColumn(nodeId);
            const result = finish(nodeId, before);
            if (batchReferenceColumns(result.table).some((column) => column.id === columnId)) throw new Error(`参考列删除未生效：${columnId}`);
            return result;
        },
        reorderReferenceColumns(nodeId: string, fromColumnId: string, toColumnId: string) {
            const before = current(nodeId).table;
            const from = requireColumn(before, fromColumnId);
            const to = requireColumn(before, toColumnId);
            native.reorderReferenceColumns(nodeId, from.id, to.id);
            return finish(nodeId, before);
        },
        moveReferenceCell(nodeId: string, sourceRowId: string, sourceColumnIndex: number, targetRowId: string, targetColumnIndex: number) {
            const before = current(nodeId).table;
            requireRow(before, sourceRowId);
            requireRow(before, targetRowId);
            requireColumnIndex(before, sourceColumnIndex);
            requireColumnIndex(before, targetColumnIndex);
            const sourceId = before.rows.find((row) => row.id === sourceRowId)!.inputNodeIds[sourceColumnIndex];
            if (!sourceId) throw new Error("源参考单元格为空");
            assertImageReferences(refs, [sourceId]);
            native.moveReferenceCell(nodeId, sourceRowId, sourceColumnIndex, targetRowId, targetColumnIndex);
            return finish(nodeId, before, targetRowId);
        },
        syncRowsFromConnections(nodeId: string) {
            const before = current(nodeId).table;
            const synchronized = native.syncRowsFromConnections(nodeId, true);
            if (!synchronized) throw new Error("当前连接无法生成批量创作行");
            return finish(nodeId, before);
        },
    };
}

export type CanvasBatchAgentOperations = ReturnType<typeof createCanvasBatchAgentOperations>;
