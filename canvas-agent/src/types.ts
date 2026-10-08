export type Position = { x: number; y: number };
export type Viewport = { x: number; y: number; k: number };
export type CanvasNodeType = "image" | "text" | "drawing" | "script" | "skill" | "config" | "video" | "audio" | "frame" | "markdown" | "svg" | "html" | "panorama" | "compare" | "chart" | "colorgrade" | "media-conversion" | "batch-table" | (string & {});
export type CanvasNode = { id: string; type: CanvasNodeType; title?: string; position: Position; width: number; height: number; parentId?: string; metadata?: Record<string, unknown> };
export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    fromHandleId?: string;
    toHandleId?: string;
    relation?: "storyboard-output" | "storyboard-asset-reference" | "batch-output";
    storyboardRowId?: string;
};
export type CanvasSnapshot = { projectId?: string; domainProjectId?: string; title?: string; nodes?: CanvasNode[]; connections?: CanvasConnection[]; selectedNodeIds?: string[]; viewport?: Viewport; clientId?: string; revision?: number };
export type AgentEmit = (type: string, payload: unknown) => void;
export type AgentAttachment = { name?: string; type?: string; dataUrl?: string };
