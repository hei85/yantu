import { describe, expect, test } from "bun:test";
import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineProject } from "@/types/timeline";
import { buildCanvasTimelineRenderSources, renderCanvasTimeline } from "@/pages/canvas/canvas-agent-timeline-render";
import { buildTimelineRenderPlan } from "@/lib/timeline/timeline-to-ffmpeg";

const timeline = (extra: Partial<TimelineProject> = {}): TimelineProject => ({
    version: 2,
    tracks: [{ id: "v", kind: "video", label: "Video", order: 0 }, { id: "a", kind: "audio", label: "Audio", order: 1 }, { id: "s", kind: "subtitle", label: "Subtitles", order: 2 }],
    clips: [{ id: "clip-1", kind: "video", nodeId: "video-1", trackId: "v", startMs: 0, durationMs: 1_000 }],
    durationMs: 1_000,
    ...extra,
});
const videoNode = (metadata: Record<string, unknown> = {}): CanvasNodeData => ({
    id: "video-1", type: "video", title: "Video", position: { x: 0, y: 0 }, width: 100, height: 100,
    metadata: { content: "data:video/mp4;base64,AA==", durationMs: 2_000, mimeType: "video/mp4", ...metadata } as CanvasNodeData["metadata"],
});

describe("canvas agent native timeline renderer", () => {
    test("builds inputs only from valid video nodes and checks the actual clip duration", () => {
        const snapshot = { expectedHash: "h1", timeline: timeline(), nodes: [videoNode()] };
        expect(buildCanvasTimelineRenderSources(snapshot)).toEqual([{
            nodeId: "video-1", clipId: "clip-1", fileName: "canvas-video-0.mp4", durationMs: 2_000, url: "data:video/mp4;base64,AA==",
        }]);
        expect(() => buildCanvasTimelineRenderSources({ ...snapshot, nodes: [] })).toThrow("缺少有效的素材节点");
        expect(() => buildCanvasTimelineRenderSources({ ...snapshot, nodes: [videoNode({ durationMs: 500 })] })).toThrow("超过素材时长");
        expect(() => buildCanvasTimelineRenderSources({ ...snapshot, nodes: [videoNode({ mimeType: "image/png" })] })).toThrow("不是视频");
    });

    test("resolves audible audio clips by clip identity and skips muted or hidden tracks", () => {
        const base = { expectedHash: "h1", nodes: [videoNode()] };
        const audio = { id: "audio-1", type: "audio", title: "Audio", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "data:audio/wav;base64,AA==", durationMs: 2_000, mimeType: "audio/wav" } } as unknown as CanvasNodeData;
        const project = timeline({ clips: [...timeline().clips, { id: "a1", kind: "audio", nodeId: "audio-1", trackId: "a", startMs: 200, durationMs: 100, volume: 0.5, fadeInMs: 20 }] });
        const sources = buildCanvasTimelineRenderSources({ ...base, nodes: [videoNode(), audio], timeline: project });
        expect(sources.map((s) => s.clipId)).toEqual(["clip-1", "a1"]);
        const plan = buildTimelineRenderPlan(project, sources);
        const mix = plan.steps.find((step) => step.kind === "audio")!;
        expect(mix.args.join(" ")).toContain("adelay=200|200");
        expect(mix.args.join(" ")).toContain("volume=0.5");
        expect(mix.args.join(" ")).toContain("afade=t=in:st=0:d=0.02");
        expect(plan.steps.find((step) => step.kind === "mux")?.args).toContain("timeline-audio.m4a");
        expect(() => buildCanvasTimelineRenderSources({ ...base, nodes: [videoNode(), audio], timeline: timeline({ tracks: timeline().tracks.map((t) => t.id === "a" ? { ...t, muted: true } : t), clips: [...timeline().clips, { id: "a1", kind: "audio", nodeId: "audio-1", trackId: "a", startMs: 0, durationMs: 100 }] }) })).not.toThrow();
    });

    test("resolves visible text and image overlays and schedules overlay rendering", () => {
        const textClip = { id: "t1", kind: "text" as const, nodeId: "asset:text", trackId: "t", startMs: 100, durationMs: 800, directMedia: { id: "text", kind: "text" as const, title: "Caption", content: "Hello overlay" } };
        const imageClip = { id: "i1", kind: "image" as const, nodeId: "asset:image", trackId: "i", startMs: 250, durationMs: 500, directMedia: { id: "image", kind: "image" as const, title: "Logo", storageKey: "image-key", mimeType: "image/png" } };
        const snap = { expectedHash: "h1", nodes: [videoNode()], timeline: timeline({ tracks: [...timeline().tracks, { id: "t", kind: "text", label: "Text", order: 3 }, { id: "i", kind: "image", label: "Image", order: 4 }], clips: [...timeline().clips, textClip, imageClip] }) };
        const sources = buildCanvasTimelineRenderSources(snap);
        expect(sources.find((source) => source.clipId === "t1")?.text).toBe("Hello overlay");
        expect(sources.find((source) => source.clipId === "i1")).toMatchObject({ storageKey: "image-key", mimeType: "image/png" });
        const plan = buildTimelineRenderPlan(snap.timeline, sources);
        expect(plan.steps.some((step) => step.kind === "overlay")).toBe(true);
        expect(plan.steps.some((step) => step.kind === "burn")).toBe(true);
    });

    test("skips hidden text and image tracks but rejects unsupported visible image formats", () => {
        const hiddenText = { id: "t1", kind: "text" as const, nodeId: "asset:text", trackId: "t", startMs: 0, durationMs: 100, directMedia: { id: "text", kind: "text" as const, title: "Caption", content: "Hidden" } };
        const hidden = timeline({ tracks: [...timeline().tracks, { id: "t", kind: "text", label: "Text", order: 3, visible: false }], clips: [...timeline().clips, hiddenText] });
        expect(buildCanvasTimelineRenderSources({ expectedHash: "h1", nodes: [videoNode()], timeline: hidden }).some((source) => source.clipId === "t1")).toBe(false);
        const image = { id: "i1", kind: "image" as const, nodeId: "asset:image", trackId: "i", startMs: 0, durationMs: 100, directMedia: { id: "image", kind: "image" as const, title: "Anim", storageKey: "image-key", mimeType: "image/gif" } };
        const unsupported = timeline({ tracks: [...timeline().tracks, { id: "i", kind: "image", label: "Image", order: 3 }], clips: [...timeline().clips, image] });
        expect(() => buildCanvasTimelineRenderSources({ expectedHash: "h1", nodes: [videoNode()], timeline: unsupported })).toThrow("暂不支持 image/gif");
    });

    test("passes visible subtitles to the verified renderer", async () => {
        const snap = { expectedHash: "h1", nodes: [videoNode()], timeline: timeline({ clips: [
            ...timeline().clips,
            { id: "subtitle-en", kind: "subtitle", nodeId: "video-1", trackId: "s", startMs: 0, durationMs: 500, text: "Hello" },
            { id: "subtitle-zh", kind: "subtitle", nodeId: "video-1", trackId: "s", startMs: 500, durationMs: 500, text: "你好" },
        ] }) };
        let renderedTimeline: TimelineProject | undefined;
        await renderCanvasTimeline(snap, {
            readCurrentExpectedHash: async () => "h1",
            onRendered: async () => undefined,
            render: async (project) => { renderedTimeline = project; return new Blob([new Uint8Array([1])], { type: "video/mp4" }); },
        });
        expect(renderedTimeline?.clips.filter((clip) => clip.kind === "subtitle").map((clip) => clip.text)).toEqual(["Hello", "你好"]);
    });

    test("checks expectedHash after rendering and only then calls the canvas writer", async () => {
        const snap = { expectedHash: "before", timeline: timeline(), nodes: [videoNode()] };
        const onRendered = async () => { throw new Error("must not write"); };
        await expect(renderCanvasTimeline(snap, {
            readCurrentExpectedHash: async () => "changed", onRendered,
            render: async () => new Blob([new Uint8Array([1])], { type: "video/mp4" }),
        })).rejects.toThrow("已更改");
        let written = false;
        await renderCanvasTimeline(snap, {
            readCurrentExpectedHash: async () => "before",
            onRendered: async (result) => { written = result.expectedHash === "before" && result.blob.size > 0; },
            render: async () => new Blob([new Uint8Array([1])], { type: "video/mp4" }),
        });
        expect(written).toBe(true);
    });
});
