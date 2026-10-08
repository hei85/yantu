import { Button, Image, Spin } from "antd";
import { cloneElement, useEffect, useState, type ImgHTMLAttributes, type ReactElement } from "react";

import { AppModal } from "@/components/ui/product/app-modal";
import { resolveImageUrl } from "@/services/image-storage";

type CanvasImagePreviewProps = {
    src?: string;
    storageKey?: string;
    alt?: string;
    onClose: () => void;
};

type PreviewSource = {
    key: string;
    status: "loading" | "ready" | "error";
    url: string;
};

export function CanvasImagePreview({ src = "", storageKey, alt = "图片", onClose }: CanvasImagePreviewProps) {
    const sourceKey = `${storageKey || ""}\n${src}`;
    const [attempt, setAttempt] = useState(0);
    const [source, setSource] = useState<PreviewSource>({ key: "", status: "loading", url: "" });

    useEffect(() => {
        if (!src && !storageKey) return;
        let cancelled = false;
        let cancelImageLoad: (() => void) | undefined;
        setSource({ key: sourceKey, status: "loading", url: "" });
        const timeout = window.setTimeout(() => {
            if (cancelled) return;
            cancelled = true;
            cancelImageLoad?.();
            setSource({ key: sourceKey, status: "error", url: "" });
        }, 30_000);

        // 节点地址可能已过期或后端暂时不可用；放大与卡片共享持久资源缓存，读取原图。
        void resolveImageUrl(storageKey, src, { cacheMiss: true }).then(async (resolvedUrl) => {
            const candidates = Array.from(new Set([resolvedUrl, src].filter(Boolean)));
            for (const url of candidates) {
                if (cancelled) return;
                const loaded = await new Promise<boolean>((resolve) => {
                    const image = new window.Image();
                    const finish = (loaded: boolean) => {
                        image.onload = image.onerror = null;
                        cancelImageLoad = undefined;
                        resolve(loaded);
                    };
                    cancelImageLoad = () => {
                        image.removeAttribute("src");
                        finish(false);
                    };
                    image.onload = () => finish(Boolean(image.naturalWidth && image.naturalHeight));
                    image.onerror = () => finish(false);
                    image.src = url;
                });
                if (cancelled) return;
                if (loaded) {
                    window.clearTimeout(timeout);
                    setSource({ key: sourceKey, status: "ready", url });
                    return;
                }
            }
            throw new Error("图片无法加载");
        }).catch(() => {
            if (cancelled) return;
            window.clearTimeout(timeout);
            setSource({ key: sourceKey, status: "error", url: "" });
        });

        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
            cancelImageLoad?.();
            // 缓存 URL 同时被画布卡片使用，关闭预览时不能 revoke。
        };
    }, [src, storageKey, sourceKey, attempt]);

    if (!src && !storageKey) return null;
    const currentSource = source.key === sourceKey ? source : { status: "loading" as const, url: "" };

    if (currentSource.status !== "ready") {
        return (
            <AppModal title={alt} open centered footer={null} onCancel={onClose} width={480}>
                <div className="flex min-h-40 flex-col items-center justify-center gap-4 text-center" role="status" aria-live="polite">
                    {currentSource.status === "loading" ? (
                        <><Spin /><span>正在加载图片…</span></>
                    ) : (
                        <><span>图片暂时无法加载，请重试。</span><Button onClick={() => setAttempt((value) => value + 1)}>重新加载</Button></>
                    )}
                </div>
            </AppModal>
        );
    }

    const handleImageError = () => setSource({ key: sourceKey, status: "error", url: "" });

    return (
        <Image
            key={`${sourceKey}:${attempt}`}
            src={currentSource.url}
            alt={alt}
            style={{ display: "none" }}
            onError={handleImageError}
            preview={{
                open: true,
                movable: true,
                minScale: 0.5,
                maxScale: 12,
                scaleStep: 0.25,
                onOpenChange: (open) => !open && onClose(),
                imageRender: (original) => cloneElement(original as ReactElement<ImgHTMLAttributes<HTMLImageElement>>, { onError: handleImageError }),
            }}
        />
    );
}
