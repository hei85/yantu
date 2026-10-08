import { useMemo, useRef, useState } from "react";
import { App, Button, Modal, Progress, Select } from "antd";
import { StatusBadge } from "@/components/ui/base/badges";
import { FileImage, UploadCloud, X } from "lucide-react";

import { ASSET_CATEGORY_OPTIONS, type AssetCategory } from "@/lib/asset-category";
import { readImageMeta } from "@/lib/image-utils";
import { setImageBlob } from "@/services/image-storage";
import { flushAssetStorePersistence, useAssetStore } from "@/stores/use-asset-store";
import type { AssetFolder } from "@/stores/use-asset-folder-store";
import { getActiveUserScope } from "@/lib/user-scope";
import { nanoid } from "nanoid";

type BatchItem = { id: string; file: File; status: "queued" | "uploading" | "done" | "error"; error?: string; percent?: number };

export function AssetBatchUploadModal({ open, defaultFolderId, folders, onClose, onComplete }: { open: boolean; defaultFolderId: string; folders: AssetFolder[]; onClose: () => void; onComplete: () => Promise<void> }) {
    const { message } = App.useApp();
    const addAsset = useAssetStore((state) => state.addAsset);
    const [items, setItems] = useState<BatchItem[]>([]);
    const [category, setCategory] = useState<AssetCategory>("material");
    const [folderId, setFolderId] = useState(defaultFolderId);
    const [tags, setTags] = useState<string[]>([]);
    const [uploading, setUploading] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const doneCount = items.filter((item) => item.status === "done").length;
    const failedItems = items.filter((item) => item.status === "error");
    const hasFiles = items.length > 0;
    const folderOptions = useMemo(() => [{ label: "未分类", value: "" }, ...folders.map((folder) => ({ label: folder.name, value: folder.id }))], [folders]);

    const chooseFiles = (files: File[]) => {
        const images = files.filter((file) => file.type.startsWith("image/"));
        if (!images.length) {
            message.warning("请选择图片文件");
            return;
        }
        setItems((current) => [...current, ...images.map((file) => ({ id: `${file.name}-${file.lastModified}-${Math.random()}`, file, status: "queued" as const }))]);
    };

    const uploadBatch = async () => {
        const pending = items.filter((item) => item.status === "queued" || item.status === "error");
        if (!pending.length) return;
        setUploading(true);
        let cursor = 0;
        const worker = async () => {
            while (cursor < pending.length) {
                const item = pending[cursor++];
                setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "uploading", percent: 10, error: undefined } : entry));
                try {
                    const previewUrl = URL.createObjectURL(item.file);
                    const meta = await readImageMeta(previewUrl).finally(() => URL.revokeObjectURL(previewUrl));
                    const storageKey = `image:${getActiveUserScope()}:${nanoid()}`;
                    const url = await setImageBlob(storageKey, item.file);
                    addAsset({ kind: "image", title: item.file.name.replace(/\.[^.]+$/, ""), category, folderId: folderId || undefined, coverUrl: url, tags, source: "批量上传", metadata: { source: "manual-batch" }, data: { dataUrl: url, storageKey, width: meta.width, height: meta.height, bytes: item.file.size, mimeType: item.file.type || meta.mimeType } });
                    setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "done", percent: 100 } : entry));
                } catch (error) {
                    setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "error", error: error instanceof Error ? error.message : "上传失败" } : entry));
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => worker()));
        await flushAssetStorePersistence();
        setUploading(false);
        await onComplete();
    };

    const close = () => {
        if (uploading) return;
        setItems([]);
        setTags([]);
        setFolderId(defaultFolderId);
        onClose();
    };

    return <Modal className="library-modal library-batch-upload-modal" title="批量上传图片" open={open} onCancel={close} footer={null} destroyOnHidden>
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-xs font-medium text-foreground/65">业务分类<Select className="mt-1 w-full" value={category} options={ASSET_CATEGORY_OPTIONS} onChange={(value) => setCategory(value)} /></label>
                <label className="text-xs font-medium text-foreground/65">自定义分类<Select className="mt-1 w-full" value={folderId} options={folderOptions} onChange={setFolderId} /></label>
                <label className="text-xs font-medium text-foreground/65">公共标签<Select mode="tags" className="mt-1 w-full" value={tags} tokenSeparators={[",", "，"]} onChange={setTags} placeholder="输入后回车" /></label>
            </div>
            <button type="button" className="batch-upload-dropzone" onClick={() => inputRef.current?.click()}>
                <UploadCloud className="size-7" /><strong>选择多张图片</strong><span>支持拖拽思路的多选上传，标题默认取文件名</span>
            </button>
            <input ref={inputRef} type="file" hidden accept="image/*" multiple onChange={(event) => { chooseFiles(Array.from(event.target.files || [])); event.currentTarget.value = ""; }} />
            {hasFiles ? <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-foreground/55"><span>已选择 {items.length} 张 · 成功 {doneCount} 张</span><button type="button" className="text-foreground/45 hover:text-foreground" onClick={() => setItems([])} disabled={uploading}>清空</button></div>
                <div className="batch-upload-list">{items.map((item) => <div key={item.id} className="batch-upload-item"><FileImage className="size-4 shrink-0 text-foreground/45" /><span className="min-w-0 flex-1 truncate" title={item.file.name}>{item.file.name}</span>{item.status === "uploading" ? <Progress percent={item.percent || 10} size="small" showInfo={false} className="w-20" /> : item.status === "done" ? <StatusBadge tone="success" size="sm" label="完成" /> : item.status === "error" ? <StatusBadge tone="error" size="sm" label="失败" title={item.error} /> : <StatusBadge tone="neutral" size="sm" label="待上传" />}<button type="button" aria-label={`移除 ${item.file.name}`} title="移除" className="batch-upload-remove" onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))} disabled={uploading}><X className="size-3.5" /></button></div>)}</div>
            </div> : null}
            <div className="flex justify-end gap-2"><Button onClick={close} disabled={uploading}>取消</Button><Button type="primary" icon={<UploadCloud className="size-4" />} onClick={() => void uploadBatch()} disabled={!items.some((item) => item.status === "queued" || item.status === "error")} loading={uploading}>{failedItems.length ? `重试失败项 (${failedItems.length})` : "开始上传"}</Button></div>
        </div>
    </Modal>;
}
