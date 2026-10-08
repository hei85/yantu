import { Unzip, UnzipInflate, zipSync } from "fflate";

type ZipFile = {
    name: string;
    data: BlobPart;
};

export async function createZip(files: ZipFile[]) {
    const entries = await Promise.all(
        files.map(async (file) => {
            const data = new Uint8Array(await new Blob([file.data]).arrayBuffer());
            return [file.name, data] as const;
        }),
    );
    return new Blob([zipSync(Object.fromEntries(entries), { level: 0 })], { type: "application/zip" });
}

export async function readZip(file: Blob, limits: { maxCompressedBytes?: number; maxEntries?: number; maxEntryBytes?: number; maxTotalBytes?: number } = {}) {
    const maxCompressedBytes = limits.maxCompressedBytes ?? Number.POSITIVE_INFINITY;
    const maxEntries = limits.maxEntries ?? Number.POSITIVE_INFINITY;
    const maxEntryBytes = limits.maxEntryBytes ?? Number.POSITIVE_INFINITY;
    const maxTotalBytes = limits.maxTotalBytes ?? Number.POSITIVE_INFINITY;
    if (file.size > maxCompressedBytes) throw new Error("ZIP 压缩文件超过允许大小");

    const entries = new Map<string, Blob>();
    const pending = new Set<string>();
    let entryCount = 0;
    let totalBytes = 0;
    let extractionError: Error | undefined;
    const unzip = new Unzip((entry) => {
        if (++entryCount > maxEntries) throw new Error("ZIP 文件条目过多");
        if (entries.has(entry.name) || pending.has(entry.name)) throw new Error(`ZIP 中存在重复路径：${entry.name}`);
        if (entry.originalSize !== undefined && entry.originalSize > maxEntryBytes) throw new Error(`ZIP 文件条目过大：${entry.name}`);
        if (entry.compression !== 0 && entry.compression !== 8) throw new Error(`ZIP 使用不支持的压缩方法：${entry.name}`);
        pending.add(entry.name);
        const parts: Uint8Array<ArrayBuffer>[] = [];
        let entryBytes = 0;
        entry.ondata = (error, chunk, final) => {
            if (error) {
                extractionError = error;
                return;
            }
            entryBytes += chunk.byteLength;
            totalBytes += chunk.byteLength;
            if (entryBytes > maxEntryBytes || totalBytes > maxTotalBytes) {
                extractionError = new Error("ZIP 解压后的数据超过允许大小");
                entry.terminate();
                return;
            }
            if (chunk.byteLength) parts.push(chunk.slice());
            if (final) {
                entries.set(entry.name, new Blob(parts));
                pending.delete(entry.name);
            }
        };
        entry.start();
    });
    unzip.register(UnzipInflate);

    const reader = file.stream().getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                unzip.push(new Uint8Array(), true);
                break;
            }
            unzip.push(value);
            if (extractionError) throw extractionError;
        }
        if (extractionError) throw extractionError;
        if (pending.size) throw new Error("ZIP 文件不完整");
        return entries;
    } finally {
        await reader.cancel().catch(() => undefined);
    }
}
