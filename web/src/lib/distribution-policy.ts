// SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
export const AXON_BASE_URL = "https://zh.heihan.dpdns.org/v1";

export function isAxonBaseUrl(raw: string): boolean {
    try {
        const url = new URL(raw);
        return url.protocol === "https:" && url.hostname === "zh.heihan.dpdns.org"
            && !url.port && !url.username && !url.password && !url.search && !url.hash
            && ["", "/v1"].includes(url.pathname.replace(/\/+$/u, ""));
    } catch { return false; }
}

export function isPublishedSystemChannel(channel: { scope?: string; baseUrl: string }): boolean {
    return channel.scope === "system" && (isAxonBaseUrl(channel.baseUrl) || /^\/api\/ai\/system\/[^/]+\/?$/u.test(channel.baseUrl));
}
