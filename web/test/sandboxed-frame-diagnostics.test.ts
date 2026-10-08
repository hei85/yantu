import { describe, expect, test } from "bun:test";

import { SANDBOX_DOM_DIAGNOSTIC_SCRIPT, withSandboxDomDiagnostics } from "../src/components/canvas/nodes/sandboxed-frame";

describe("sandbox frame DOM diagnostics", () => {
    test("injects a nonce challenge listener only for script-enabled frames", () => {
        const html = "<!doctype html><html><body><p>fixture</p></body></html>";
        const enabled = withSandboxDomDiagnostics(html, true);
        expect(enabled.indexOf(SANDBOX_DOM_DIAGNOSTIC_SCRIPT)).toBeGreaterThan(enabled.indexOf("<p>fixture</p>"));
        expect(enabled).toContain("event.source!==parent");
        expect(enabled).toContain("scrollOverflowY");
        expect(withSandboxDomDiagnostics(html, false)).toBe(html);
    });

    test("does not append the bridge more than once", () => {
        const first = withSandboxDomDiagnostics("<body>fixture</body>", true);
        expect(withSandboxDomDiagnostics(first, true)).toBe(first);
    });
});
