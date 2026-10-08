import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServerResponse } from "node:http";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const TRANSFER_TTL_MS = 5 * 60 * 1000;
const MIME_BY_EXTENSION: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac",
    ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".srt": "application/x-subrip; charset=utf-8", ".zip": "application/zip",
};

type UploadBinding = { clientId: string; runtimeSessionId: string; canvasId: string };
type UploadRecord = UploadBinding & { id: string; filePath: string; fileName: string; mimeType: string; size: number; expiresAt: number; timer: NodeJS.Timeout };

export class LocalCanvasFileTransfers {
    private readonly root = path.join(os.tmpdir(), `framefield-canvas-${crypto.randomUUID()}`);
    private readonly records = new Map<string, UploadRecord>();

    async create(sourcePath: string, binding: UploadBinding) {
        if (!path.isAbsolute(sourcePath)) throw new Error("filePath 必须是本机绝对路径");
        if (!binding.clientId || !binding.runtimeSessionId || !binding.canvasId) throw new Error("当前画布没有可验证的浏览器本机连接，无法安全传输文件");
        const realPath = await fsp.realpath(sourcePath);
        const stat = await fsp.stat(realPath);
        if (!stat.isFile()) throw new Error("filePath 必须指向一个普通文件");
        if (stat.size <= 0 || stat.size > MAX_UPLOAD_BYTES) throw new Error(`文件大小必须在 1 字节到 ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB 之间`);
        const extension = path.extname(realPath).toLowerCase();
        const mimeType = MIME_BY_EXTENSION[extension];
        if (!mimeType) throw new Error("仅支持 PNG/JPEG/WebP/GIF、MP4/MOV/WebM、MP3/WAV/M4A/AAC/OGG/FLAC，以及 TXT/MD/SRT");

        await fsp.mkdir(this.root, { recursive: true });
        const id = crypto.randomUUID();
        const stagedPath = path.join(this.root, id);
        let size = 0;
        const hash = crypto.createHash("sha256");
        const limiter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                size += chunk.length;
                if (size > MAX_UPLOAD_BYTES) return callback(new Error("文件超过 100 MiB 上限"));
                hash.update(chunk);
                callback(null, chunk);
            },
        });
        try {
            await pipeline(fs.createReadStream(realPath), limiter, fs.createWriteStream(stagedPath, { flags: "wx", mode: 0o600 }));
            const header = Buffer.alloc(32);
            const handle = await fsp.open(stagedPath, "r");
            try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
            validateFileSignature(mimeType.split(";", 1)[0], header.subarray(0, Math.min(size, header.length)));
            if (!size) throw new Error("文件内容为空");
            const record: UploadRecord = {
                ...binding,
                id,
                filePath: stagedPath,
                fileName: path.basename(realPath),
                mimeType,
                size,
                expiresAt: Date.now() + TRANSFER_TTL_MS,
                timer: setTimeout(() => void this.remove(id), TRANSFER_TTL_MS),
            };
            this.records.set(id, record);
            return { uploadId: id, fileName: record.fileName, mimeType, size, sha256: hash.digest("hex") };
        } catch (error) {
            await fsp.rm(stagedPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    streamOnce(id: string, clientId: string, runtimeSessionId: string, res: ServerResponse) {
        const record = this.records.get(id);
        if (!record || record.clientId !== clientId || record.runtimeSessionId !== runtimeSessionId || Date.now() >= record.expiresAt) {
            res.statusCode = 404;
            res.end();
            return;
        }
        this.records.delete(id);
        clearTimeout(record.timer);
        res.statusCode = 200;
        res.setHeader("Content-Type", record.mimeType);
        res.setHeader("Content-Length", String(record.size));
        res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(record.fileName)}`);
        res.setHeader("Cache-Control", "no-store");
        const source = fs.createReadStream(record.filePath);
        source.on("error", () => { if (!res.headersSent) res.statusCode = 500; res.end(); });
        res.on("close", () => void this.removePath(record.filePath));
        source.pipe(res);
    }

    discard(id: string) {
        void this.remove(id);
    }

    removeForRuntimeSession(runtimeSessionId: string) {
        for (const [id, record] of this.records) if (record.runtimeSessionId === runtimeSessionId) void this.remove(id);
    }

    dispose() {
        for (const id of this.records.keys()) void this.remove(id);
        void fsp.rm(this.root, { recursive: true, force: true }).catch(() => undefined);
    }

    private async remove(id: string) {
        const record = this.records.get(id);
        if (!record) return;
        this.records.delete(id);
        clearTimeout(record.timer);
        await this.removePath(record.filePath);
    }

    private async removePath(filePath: string) {
        await fsp.rm(filePath, { force: true }).catch(() => undefined);
    }
}

function validateFileSignature(mimeType: string, bytes: Buffer) {
    const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
    const ascii = (start: number, length: number) => bytes.toString("ascii", start, start + length);
    const valid = mimeType === "image/png" ? starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
        : mimeType === "image/jpeg" ? starts(0xff, 0xd8, 0xff)
        : mimeType === "image/webp" ? ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP"
        : mimeType === "image/gif" ? ["GIF87a", "GIF89a"].includes(ascii(0, 6))
        : mimeType === "video/mp4" || mimeType === "video/quicktime" ? ascii(4, 4) === "ftyp"
        : mimeType === "video/webm" ? starts(0x1a, 0x45, 0xdf, 0xa3)
        : mimeType === "audio/wav" ? ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE"
        : mimeType === "audio/ogg" ? ascii(0, 4) === "OggS"
        : mimeType === "audio/flac" ? ascii(0, 4) === "fLaC"
        : mimeType === "audio/mpeg" ? ascii(0, 3) === "ID3" || starts(0xff, 0xfb) || starts(0xff, 0xf3) || starts(0xff, 0xf2)
        : mimeType === "audio/aac" ? starts(0xff, 0xf1) || starts(0xff, 0xf9)
        : mimeType === "audio/mp4" ? ascii(4, 4) === "ftyp"
        : mimeType === "application/zip" ? starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06) || starts(0x50, 0x4b, 0x07, 0x08)
        : mimeType.startsWith("text/") || mimeType === "application/x-subrip" ? isUtf8Text(bytes)
        : false;
    if (!valid) throw new Error(`文件内容与扩展名对应的 MIME 类型不匹配：${mimeType}`);
}

function isUtf8Text(bytes: Buffer) {
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return !bytes.includes(0);
    } catch {
        return false;
    }
}
