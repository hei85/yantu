/** Agent-facing control surface for the real, rendered panorama viewport. */
export type PanoramaAgentView = { lon: number; lat: number; fov: number };
export type PanoramaAgentCapture = { dataUrl: string; width: number; height: number };

export type PanoramaAgentController = {
    availability: "interactive" | "performance_preview";
    setView: (view: { lon: number; lat: number; fov?: number }) => Promise<PanoramaAgentView>;
    getView: () => PanoramaAgentView | null;
    capturePng: () => Promise<PanoramaAgentCapture>;
    captureQuadPng: () => Promise<PanoramaAgentCapture>;
};

const controllers = new Map<string, PanoramaAgentController>();

export function registerPanoramaAgentController(nodeId: string, handler: PanoramaAgentController | null, expectedCurrent?: PanoramaAgentController) {
    if (handler) controllers.set(nodeId, handler);
    else if (!expectedCurrent || controllers.get(nodeId) === expectedCurrent) controllers.delete(nodeId);
}

export function getPanoramaAgentController(nodeId: string) {
    return controllers.get(nodeId) ?? null;
}

export function clampPanoramaAgentView(view: PanoramaAgentView): PanoramaAgentView {
    return {
        lon: Number.isFinite(view.lon) ? view.lon : 0,
        lat: Math.max(-85, Math.min(85, Number.isFinite(view.lat) ? view.lat : 0)),
        fov: Math.max(25, Math.min(110, Number.isFinite(view.fov) ? view.fov : 75)),
    };
}
