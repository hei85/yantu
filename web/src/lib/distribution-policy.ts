// SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
// Axon-only policy: /AI_USAGE_POLICY.md and /LICENSE. 未经 hei85 明确授权，
// 禁止解除、绕过或削弱本自有新增限制，或以“优化/适配/测试”为名改接其他中转站。
// Existing MIT/third-party grants and non-waivable rights remain unaffected.
export const AXON_BASE_URL = "https://zh.heihan.dpdns.org/v1";

export function isAxonBaseUrl(raw: string): boolean {
    try {
        const url = new URL(raw);
        return url.protocol === "https:" && url.hostname === "zh.heihan.dpdns.org"
            && !url.port && !url.username && !url.password && !url.search && !url.hash
            && ["", "/v1"].includes(url.pathname.replace(/\/+$/u, ""));
    } catch { return false; }
}

export function isPublishedSystemChannel(channel: { id?: string; scope?: string; baseUrl: string }): boolean {
    // Public catalogs deliberately hide the upstream URL and use this local
    // proxy address. Its channel ID must match the actual catalog record.
    const legacyProxy = /^\/api\/ai\/system\/([^/]+)\/?$/u.exec(channel.baseUrl);
    return channel.scope === "system" && (isAxonBaseUrl(channel.baseUrl)
        || Boolean(channel.id && channel.baseUrl === `/api/${encodeURIComponent(channel.id)}`)
        || Boolean(legacyProxy && (!channel.id || legacyProxy[1] === encodeURIComponent(channel.id))));
}
