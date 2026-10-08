import { useCallback, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";
import { nanoid } from "nanoid";

import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { batchInputColumns, batchPromptForRow, batchReferenceColumns, batchReferenceHandleId, createBatchRowsFromColumns, createInheritedBatchRow, moveBatchReferenceCell, removeLastBatchReferenceColumn, reorderBatchReferenceColumns } from "@/lib/canvas/canvas-batch-table";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { buildGenerationConfig, resetGenerationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { navigateToSettings } from "@/lib/settings-navigation";
import { modelDisplayName, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasBatchRow, type CanvasBatchTableData, type CanvasConnection, type CanvasGenerationBatchMode, type CanvasNodeData } from "@/types/canvas";
import { createCanvasBatchAgentOperations } from "./canvas-agent-batch-operations";
import { preflightBatchTableRows, type CanvasAgentBatchRowPreflight } from "./canvas-agent-batch-generation-preflight";

type Options = {
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    enqueueGenerationBatch: (sourceNodeId: string, mode: CanvasGenerationBatchMode, targets: Array<{ rowId: string; nodeId: string }>, options?: { concurrency?: number; clientOperationId?: string }) => string | undefined;
};

export function assertBatchOperationRowIdsMatch(requestedRowIds: string[], batchRowIds: string[]) {
    if ([...requestedRowIds].sort().join("\u0000") !== [...batchRowIds].sort().join("\u0000")) {
        throw new Error("相同 clientOperationId 已绑定不同批量行；拒绝重放收费操作");
    }
}

export function useCanvasBatchTable({ nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds, enqueueGenerationBatch }: Options) {
    const { message, modal } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);

    const patchTable = useCallback((nodeId: string, patch: Partial<CanvasBatchTableData>) => {
        const current = nodesRef.current;
        const target = current.find((node) => node.id === nodeId);
        if (!target || target.type !== CanvasNodeType.BatchTable || !target.metadata?.batchTable) return;
        const table = target.metadata.batchTable;
        const next = current.map((node) => node.id !== nodeId ? node : { ...node, metadata: { ...node.metadata, batchTable: { ...table, ...patch } } });
        setNodes(next);
        return nodesRef.current.find((node) => node.id === nodeId)?.metadata?.batchTable;
    }, [nodesRef, setNodes]);

    const updateRow = useCallback((nodeId: string, rowId: string, patch: Partial<CanvasBatchRow>) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if (!node?.metadata?.batchTable) return;
        patchTable(nodeId, { rows: node.metadata.batchTable.rows.map((row) => row.id === rowId ? { ...row, ...patch } : row) });
    }, [nodesRef, patchTable]);

    const addRow = useCallback((nodeId: string) => {
        const table = nodesRef.current.find((item) => item.id === nodeId)?.metadata?.batchTable;
        if (!table) return;
        patchTable(nodeId, { rows: [...table.rows, createInheritedBatchRow(table.operation, table.rows)] });
    }, [nodesRef, patchTable]);

    const removeRow = useCallback((nodeId: string, rowId: string) => {
        const table = nodesRef.current.find((item) => item.id === nodeId)?.metadata?.batchTable;
        if (!table) return;
        patchTable(nodeId, { rows: table.rows.filter((row) => row.id !== rowId) });
    }, [nodesRef, patchTable]);

    const addReferenceColumn = useCallback((nodeId: string) => {
        const table = nodesRef.current.find((item) => item.id === nodeId)?.metadata?.batchTable;
        if (!table) return;
        const columns = batchReferenceColumns(table);
        if (columns.length >= 6) return message.info("最多支持 6 组参考图");
        const nextIndex = columns.length + 1;
        patchTable(nodeId, { referenceColumns: [...columns, { id: `reference-${nanoid()}`, label: `参考图 ${nextIndex}` }] });
    }, [message, nodesRef, patchTable]);

    const removeReferenceColumn = useCallback((nodeId: string) => {
        const table = nodesRef.current.find((item) => item.id === nodeId)?.metadata?.batchTable;
        if (!table) return;
        const columns = batchReferenceColumns(table);
        const nextTable = removeLastBatchReferenceColumn(table);
        if (!nextTable) return message.info("至少保留 1 组参考图");
        const removed = columns.at(-1);
        patchTable(nodeId, nextTable);
        if (removed) {
            const handleId = batchReferenceHandleId(removed.id);
            const next = connectionsRef.current.filter((connection) => !(connection.toNodeId === nodeId && connection.toHandleId === handleId));
            connectionsRef.current = next;
            setConnections(next);
        }
    }, [connectionsRef, message, nodesRef, patchTable, setConnections]);

    const syncRowsFromConnections = useCallback((nodeId: string, silent = false) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        const table = node?.metadata?.batchTable;
        if (!node || !table) return false;
        const nodeById = new Map(nodesRef.current.map((item) => [item.id, item]));
        const columns = batchInputColumns(node, connectionsRef.current).map((column) => column.filter((inputNodeId) => {
            const input = nodeById.get(inputNodeId);
            return input?.type === CanvasNodeType.Image && Boolean(input.metadata?.content || input.metadata?.storageKey);
        }));
        if (!columns.some((column) => column.length)) {
            if (!silent) message.warning("请先把图片节点连接到批量创作表");
            return false;
        }
        const rows = createBatchRowsFromColumns(table.operation, columns, table.rows);
        if (!rows.length) {
            if (!silent) message.warning("批量换装至少需要一张人物图和一张服装图");
            return false;
        }
        if (JSON.stringify(rows) === JSON.stringify(table.rows)) return true;
        patchTable(nodeId, { rows });
        if (!silent) {
            const added = Math.max(0, rows.length - table.rows.length);
            message.success(added ? `已同步连线并新增 ${added} 行，原有任务均已保留` : "已同步最新连线，原有任务均已保留");
        }
        return true;
    }, [connectionsRef, message, nodesRef, patchTable]);

    const fillRowsFromConnections = useCallback((nodeId: string) => {
        syncRowsFromConnections(nodeId);
    }, [syncRowsFromConnections]);

    const reorderReferenceColumns = useCallback((nodeId: string, fromColumnId: string, toColumnId: string) => {
        const table = nodesRef.current.find((item) => item.id === nodeId)?.metadata?.batchTable;
        if (!table) return;
        const nextTable = reorderBatchReferenceColumns(table, fromColumnId, toColumnId);
        if (nextTable !== table) patchTable(nodeId, nextTable);
    }, [nodesRef, patchTable]);

    const moveReferenceCell = useCallback((nodeId: string, sourceRowId: string, sourceColumnIndex: number, targetRowId: string, targetColumnIndex: number) => {
        const table = nodesRef.current.find((item) => item.id === nodeId)?.metadata?.batchTable;
        if (!table) return;
        const nextTable = moveBatchReferenceCell(table, sourceRowId, sourceColumnIndex, targetRowId, targetColumnIndex);
        if (nextTable !== table) patchTable(nodeId, { rows: nextTable.rows });
    }, [nodesRef, patchTable]);

    const runBatchRows = useCallback(async (nodeId: string, requestedRowIds: string[] | undefined, clientOperationId?: string, beforeCommit?: () => Promise<void>) => {
        const sourceNode = nodesRef.current.find((item) => item.id === nodeId);
        const table = sourceNode?.metadata?.batchTable;
        if (!sourceNode || !table) return undefined;
        const imageModel = effectiveConfig.imageModel || effectiveConfig.model;
        if (!isAiConfigReady(effectiveConfig, imageModel)) {
            navigateToSettings({ continueCreation: true });
            return undefined;
        }
        const generationConfig = buildGenerationConfig(effectiveConfig, undefined, "image");
        const imageResolution = /^(1k|2k|4k)$/i.test(generationConfig.quality) ? generationConfig.quality.toUpperCase() : "由尺寸决定";
        const activeNodeIds = new Set((sourceNode.metadata?.generationBatches || []).filter((batch) => batch.mode === "batch_image").flatMap((batch) => batch.items.filter((item) => ["waiting", "submitting", "queued", "running"].includes(item.status)).map((item) => item.nodeId)));
        const requested = requestedRowIds?.length ? requestedRowIds : table.rows.filter((row) => row.enabled).map((row) => row.id);
        const checked = preflightBatchTableRows({ table, nodes: nodesRef.current, rowIds: requested, activeNodeIds: [...activeNodeIds], modelReady: true });
        const previousBatch = clientOperationId ? nodesRef.current.flatMap((node) => node.metadata?.generationBatches || []).find((batch) => batch.clientOperationId === clientOperationId) : undefined;
        if (previousBatch && requestedRowIds?.length) assertBatchOperationRowIdsMatch(requestedRowIds, previousBatch.items.map((item) => item.rowId));
        const rows = previousBatch
            ? previousBatch.items.map((item) => table.rows.find((row) => row.id === item.rowId)).filter((row): row is NonNullable<typeof row> => Boolean(row))
            : checked.filter((row) => row.status === "ready" || ((Boolean(requestedRowIds?.length) || Boolean(clientOperationId)) && row.status === "completed")).map((entry) => table.rows.find((row) => row.id === entry.rowId)!);
        if (!rows.length) { message.info("没有可提交的未完成任务，请检查参考图和提示词"); return { rows: checked }; }
        if (previousBatch && (previousBatch.sourceNodeId !== nodeId || previousBatch.mode !== "batch_image")) throw new Error("相同 clientOperationId 已绑定不同批量行；拒绝重放收费操作");
        const confirmed = previousBatch ? true : await new Promise<boolean>((resolve) => modal.confirm({
            title: `确认提交 ${rows.length} 个批量图片任务`,
            content: [
                `模型：${modelDisplayName(effectiveConfig, generationConfig.model) || generationConfig.model}`,
                `出图数量：${rows.length} 张（每行 1 张）`,
                `尺寸：${generationConfig.size || "默认"}`,
                `质量：${generationConfig.quality || "默认"}`,
                `分辨率：${imageResolution}`,
                `并发：${table.concurrency}`,
                "这些任务会调用模型执行。",
            ].join("\n"),
            okText: "确认生成",
            cancelText: "取消",
            centered: true,
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
        }));
        if (!confirmed) return { cancelled: true, checked };
        const inputStamp = JSON.stringify(rows.map((row) => ({ rowId: row.id, prompt: batchPromptForRow(table, row).trim(), inputNodeIds: row.inputNodeIds, textNodeIds: row.textNodeIds, assets: [...row.inputNodeIds, ...(row.textNodeIds || [])].map((id) => { const asset = nodesRef.current.find((item) => item.id === id); return [id, asset?.type, asset?.metadata?.assetId, asset?.metadata?.storageKey, asset?.metadata?.content, asset?.metadata?.prompt]; }) })));
        await beforeCommit?.();
        const latest = nodesRef.current.find((item) => item.id === nodeId);
        const latestTable = latest?.metadata?.batchTable;
        const latestRows = latestTable ? rows.map((row) => latestTable.rows.find((item) => item.id === row.id)).filter((row): row is NonNullable<typeof row> => Boolean(row)) : [];
        const latestStamp = JSON.stringify(latestTable ? latestRows.map((row) => ({ rowId: row.id, prompt: batchPromptForRow(latestTable, row).trim(), inputNodeIds: row.inputNodeIds, textNodeIds: row.textNodeIds, assets: [...row.inputNodeIds, ...(row.textNodeIds || [])].map((id) => { const asset = nodesRef.current.find((item) => item.id === id); return [id, asset?.type, asset?.metadata?.assetId, asset?.metadata?.storageKey, asset?.metadata?.content, asset?.metadata?.prompt]; }) })) : []);
        if (inputStamp !== latestStamp || latestRows.length !== rows.length) throw new Error("确认后批量行或参考图已变化；请重新预检并确认");
        if (previousBatch) {
            const recoveredId = enqueueGenerationBatch(nodeId, "batch_image", previousBatch.items.map((item) => ({ rowId: item.rowId, nodeId: item.nodeId })), { concurrency: table.concurrency, clientOperationId });
            if (!recoveredId) throw new Error("无法使用相同 clientOperationId 恢复原批次");
            return { batchId: recoveredId, rows: checked.map((entry) => ({ ...entry, ...(previousBatch.items.find((item) => item.rowId === entry.rowId) ? { nodeId: previousBatch.items.find((item) => item.rowId === entry.rowId)!.nodeId, taskId: previousBatch.items.find((item) => item.rowId === entry.rowId)!.taskId, status: previousBatch.items.find((item) => item.rowId === entry.rowId)!.status } : {}) })) };
        }

        const imageSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const nextNodes = [...nodesRef.current];
        let nextConnections = [...connectionsRef.current];
        const outputByRowId = new Map<string, string>();
        const targets: Array<{ rowId: string; nodeId: string }> = [];
        rows.forEach((row, index) => {
            const existingIndex = row.outputNodeId ? nextNodes.findIndex((node) => node.id === row.outputNodeId && node.type === CanvasNodeType.Image) : -1;
            const prompt = batchPromptForRow(table, row).trim();
            const metadata = {
                ...(existingIndex >= 0 ? resetGenerationTaskMetadata(nextNodes[existingIndex].metadata) : {}),
                prompt,
                composerContent: prompt,
                model: generationConfig.model,
                size: generationConfig.size,
                quality: generationConfig.quality,
                transparentBackground: generationConfig.transparentBackground,
                count: 1,
                generationMode: "image" as const,
                generationType: "edit" as const,
                workflowKind: "final" as const,
                workflowTitle: `${table.operation === "try_on" ? "换装" : "创意"}任务 ${index + 1}`,
                status: "idle" as const,
                batchSourceNodeId: nodeId,
                batchRowId: row.id,
                batchOperation: table.operation,
                batchInputNodeIds: row.inputNodeIds,
            };
            const output = existingIndex >= 0
                ? { ...nextNodes[existingIndex], metadata }
                : createCanvasNode(CanvasNodeType.Image, { x: sourceNode.position.x + sourceNode.width + 120 + imageSpec.width / 2, y: sourceNode.position.y + index * (imageSpec.height + 32) + imageSpec.height / 2 }, metadata);
            output.title = `${table.operation === "try_on" ? "换装" : "创意"} · ${index + 1}`;
            if (existingIndex >= 0) nextNodes[existingIndex] = output;
            else nextNodes.push(output);
            nextConnections = nextConnections.filter((connection) => connection.toNodeId !== output.id);
            row.inputNodeIds.filter(Boolean).forEach((inputNodeId) => nextConnections.push({ id: nanoid(), fromNodeId: inputNodeId, toNodeId: output.id }));
            nextConnections.push({ id: nanoid(), fromNodeId: sourceNode.id, toNodeId: output.id, relation: "batch-output", storyboardRowId: row.id });
            outputByRowId.set(row.id, output.id);
            targets.push({ rowId: row.id, nodeId: output.id });
        });
        const sourceIndex = nextNodes.findIndex((node) => node.id === sourceNode.id);
        nextNodes[sourceIndex] = { ...sourceNode, metadata: { ...sourceNode.metadata, batchTable: { ...table, rows: table.rows.map((row) => outputByRowId.has(row.id) ? { ...row, outputNodeId: outputByRowId.get(row.id) } : row) } } };
        nodesRef.current = nextNodes;
        connectionsRef.current = nextConnections;
        setNodes(nextNodes);
        setConnections(nextConnections);
        setSelectedNodeIds(new Set(targets.map((target) => target.nodeId)));
        const batchId = enqueueGenerationBatch(nodeId, "batch_image", targets, { concurrency: table.concurrency, ...(clientOperationId ? { clientOperationId } : {}) });
        if (batchId) message.success(`${targets.length} 个任务已加入并发队列`);
        return { batchId, rows: checked.map((entry) => { const target = targets.find((item) => item.rowId === entry.rowId); return { ...entry, ...(target ? { nodeId: target.nodeId, status: "waiting" as const } : {}) }; }) };
    }, [connectionsRef, effectiveConfig, enqueueGenerationBatch, isAiConfigReady, message, modal, nodesRef, setConnections, setNodes, setSelectedNodeIds]);

    const generateRows = useCallback(async (nodeId: string, requestedRowIds?: string[]) => runBatchRows(nodeId, requestedRowIds), [runBatchRows]);
    const agentPreflightBatchRows = useCallback((input: { nodeId: string; rowIds: string[] }) => {
        const source = nodesRef.current.find((node) => node.id === input.nodeId);
        const table = source?.metadata?.batchTable;
        if (!table) throw new Error("批量创作表不存在");
        const imageModel = effectiveConfig.imageModel || effectiveConfig.model;
        const active = new Set((source.metadata?.generationBatches || []).filter((batch) => batch.mode === "batch_image").flatMap((batch) => batch.items.filter((item) => ["waiting", "submitting", "queued", "running"].includes(item.status)).map((item) => item.nodeId)));
        const rows = preflightBatchTableRows({ table, nodes: nodesRef.current, rowIds: input.rowIds, activeNodeIds: [...active], modelReady: isAiConfigReady(effectiveConfig, imageModel) });
        return { nodeId: input.nodeId, model: imageModel, status: rows.some((row) => row.status === "ready") ? "ready" as const : rows.some((row) => row.status === "running") ? "running" as const : "blocked" as const, submitted: false as const, rows };
    }, [effectiveConfig, isAiConfigReady, nodesRef]);
    const agentGenerateBatchRows = useCallback(async (input: { nodeId: string; rowIds: string[]; clientOperationId: string }, beforeCommit: () => Promise<void>) => {
        const operationId = input.clientOperationId.trim();
        if (!operationId || operationId.length > 96) throw new Error("clientOperationId 必须是 1 至 96 字符的稳定标识");
        const preflight = agentPreflightBatchRows(input);
        const result = await runBatchRows(input.nodeId, input.rowIds, operationId, beforeCommit);
        if (!result || typeof result !== "object") return { nodeId: input.nodeId, clientOperationId: operationId, status: "failed" as const, submitted: false, rows: preflight.rows };
        if ("cancelled" in result && result.cancelled) return { nodeId: input.nodeId, clientOperationId: operationId, status: "cancelled" as const, submitted: false, rows: preflight.rows };
        if (!("batchId" in result) || !result.batchId) return { nodeId: input.nodeId, clientOperationId: operationId, status: "blocked" as const, submitted: false, rows: preflight.rows };
        const batch = nodesRef.current.find((node) => node.id === input.nodeId)?.metadata?.generationBatches?.find((item) => item.id === result.batchId);
        const rows = result.rows as Array<CanvasAgentBatchRowPreflight & { status: string }>;
        return { nodeId: input.nodeId, clientOperationId: operationId, ...(result.batchId ? { batchId: result.batchId } : {}), status: batch?.status || "queued", submitted: Boolean(result.batchId), rows: rows.map((row) => { const item = batch?.items.find((candidate) => candidate.rowId === row.rowId); return { ...row, ...(item?.taskId ? { taskId: item.taskId } : {}), status: item?.status || row.status }; }) };
    }, [agentPreflightBatchRows, nodesRef, runBatchRows]);

    const agentOperations = createCanvasBatchAgentOperations({ nodesRef, connectionsRef }, {
        addReferenceColumn,
        addRow,
        moveReferenceCell,
        removeReferenceColumn,
        removeRow,
        reorderReferenceColumns,
        syncRowsFromConnections,
        updateRow,
    });

    return { addReferenceColumn, addRow, agentOperations, agentPreflightBatchRows, agentGenerateBatchRows, fillRowsFromConnections, generateRows, moveReferenceCell, patchTable, removeReferenceColumn, removeRow, reorderReferenceColumns, syncRowsFromConnections, updateRow };
}
