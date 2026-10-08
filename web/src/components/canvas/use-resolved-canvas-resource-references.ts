import { useEffect, useMemo, useState } from "react";

import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { loadCanvasDrawingPreview } from "@/lib/canvas/canvas-drawing-storage";
import { resolveImageUrl } from "@/services/image-storage";

type ResolvedPreview = {
    identity: string;
    url: string;
};

const previewPromiseCache = new Map<string, Promise<string>>();

export function useResolvedCanvasResourceReferences(references: CanvasResourceReference[], options?: { projectId?: string }) {
    const projectId = options?.projectId;
    const requests = useMemo(
        () => references.flatMap((reference) => {
            const identity = previewIdentity(reference, projectId);
            return identity ? [{ reference, identity }] : [];
        }),
        [projectId, references],
    );
    const [resolvedById, setResolvedById] = useState<Record<string, ResolvedPreview>>({});

    useEffect(() => {
        if (!requests.length) return;
        let cancelled = false;
        requests.forEach(({ reference, identity }) => {
            void resolveReferencePreview(reference, identity, projectId).then((url) => {
                if (cancelled || !url) return;
                setResolvedById((current) => {
                    if (current[reference.id]?.identity === identity && current[reference.id]?.url === url) return current;
                    return { ...current, [reference.id]: { identity, url } };
                });
            });
        });
        return () => {
            cancelled = true;
        };
    }, [projectId, requests]);

    return useMemo(
        () => references.map((reference) => {
            const identity = previewIdentity(reference, projectId);
            const resolved = identity ? resolvedById[reference.id] : undefined;
            return resolved?.identity === identity && resolved.url !== reference.previewUrl ? { ...reference, previewUrl: resolved.url } : reference;
        }),
        [projectId, references, resolvedById],
    );
}

function previewIdentity(reference: CanvasResourceReference, projectId?: string) {
    // 只有当 drawingId 和 projectId 同时存在时才返回绘图身份,避免不完整的缓存键导致运行时错误
    if (reference.drawingId) {
        if (!projectId) return "";
        return `drawing:${projectId}:${reference.drawingId}:${reference.drawingRevision || 0}`;
    }
    const storageKey = reference.kind === "video" ? reference.previewStorageKey : reference.storageKey;
    if (!storageKey || !["image", "video", "character"].includes(reference.kind)) return "";
    return `${reference.kind}:${storageKey}`;
}

function resolveReferencePreview(reference: CanvasResourceReference, identity: string, projectId?: string) {
    const cacheKey = JSON.stringify([identity, reference.previewUrl || ""]);
    const cached = previewPromiseCache.get(cacheKey);
    if (cached) return cached;
    if (reference.drawingId && projectId) {
        const pending = loadCanvasDrawingPreview(projectId, reference.drawingId)
            .then((preview) => preview ? blobToDataUrl(preview) : reference.previewUrl || "")
            .catch(() => reference.previewUrl || "");
        previewPromiseCache.set(cacheKey, pending);
        void pending.finally(() => {
            if (previewPromiseCache.get(cacheKey) === pending) previewPromiseCache.delete(cacheKey);
        });
        return pending;
    }
    const storageKey = reference.kind === "video" ? reference.previewStorageKey : reference.storageKey;
    const pending = resolveImageUrl(storageKey, reference.previewUrl || "", { cacheMiss: true })
        .catch(() => reference.previewUrl || "");
    // Deduplicate in-flight reads only. A transient URL/cache miss must not be
    // frozen for the lifetime of the page after the resource becomes available.
    previewPromiseCache.set(cacheKey, pending);
    void pending.finally(() => {
        if (previewPromiseCache.get(cacheKey) === pending) previewPromiseCache.delete(cacheKey);
    });
    return pending;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error("读取绘图预览失败"));
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.readAsDataURL(blob);
    });
}
