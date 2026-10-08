import type { StoryboardAssetBinding } from "@/types/canvas";

/** Display the row's opening frame first, then each reference once with all its roles. */
export function storyboardDisplayAssets(bindings: StoryboardAssetBinding[], firstFrameNodeId?: string) {
    const assets: Array<{ nodeId: string; firstFrame: boolean; roles: StoryboardAssetBinding["role"][] }> = [];
    if (firstFrameNodeId) assets.push({ nodeId: firstFrameNodeId, firstFrame: true, roles: [] });
    for (const binding of bindings) {
        let asset = assets.find((item) => item.nodeId === binding.nodeId);
        if (!asset) {
            asset = { nodeId: binding.nodeId, firstFrame: false, roles: [] };
            assets.push(asset);
        }
        if (!asset.roles.includes(binding.role)) asset.roles.push(binding.role);
    }
    return assets;
}
