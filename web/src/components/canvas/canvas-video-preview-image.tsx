import { CachedResourceImage } from "@/components/cached-resource-image";
import type { ComponentProps } from "react";
import { canvasNodeVideoPreviewUrl } from "@/lib/canvas/canvas-media-preview";
import type { CanvasNodeData } from "@/types/canvas";

type Props = Omit<ComponentProps<typeof CachedResourceImage>, "src" | "storageKey"> & { node: CanvasNodeData };

/** Restore posters by their durable storage identity after a reload. */
export function CanvasVideoPreviewImage({ node, ...props }: Props) {
    const preview = node.metadata?.videoPreview;
    const generated = Boolean(preview?.content && preview.content !== node.metadata?.content);
    return <span className="block size-full"><CachedResourceImage {...props} src={canvasNodeVideoPreviewUrl(node)} storageKey={generated ? preview?.storageKey : undefined} /></span>;
}
