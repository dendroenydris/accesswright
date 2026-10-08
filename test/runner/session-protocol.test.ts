import { describe, expect, it } from "vitest";
import { BrowserCommandSchema, targetProcessEnvironment, sourceRoutesForChanges } from "../../src/runner/session-protocol.js";

describe("persistent runner protocol boundaries", () => {
  it.each(["https://evil.example", "http://169.254.169.254", "http://accesswright-app:3000@evil.example", "http://accesswright-app:3000/private"])("rejects scanner URL %s", baseUrl => {
    expect(BrowserCommandSchema.safeParse({ action: "crawl", baseUrl }).success).toBe(false);
  });
  it("accepts only relative same-origin routes and safe evidence names", () => {
    expect(BrowserCommandSchema.safeParse({ action: "scan", baseUrl: "http://accesswright-app:3000", routes: ["/"], generation: "baseline-1", mobile: true, dark: false, interactions: true }).success).toBe(true);
    expect(BrowserCommandSchema.safeParse({ action: "scan", baseUrl: "http://accesswright-app:3000", routes: ["//evil.example"], generation: "baseline-1", mobile: true, dark: false, interactions: true }).success).toBe(false);
    expect(BrowserCommandSchema.safeParse({ action: "scan", baseUrl: "http://accesswright-app:3000", routes: ["/"], generation: "../../outside", mobile: true, dark: false, interactions: true }).success).toBe(false);
  });
  it("never forwards host credentials or NODE_OPTIONS to target code", () => {
    const env = targetProcessEnvironment({ PATH: "/usr/bin", HOME: "/home/pwuser", OPENAI_API_KEY: "fixture", GITHUB_TOKEN: "fixture", NODE_OPTIONS: "--require=/malicious.js" });
    expect(env).toEqual({ PATH: "/workspace/node_modules/.accesswright-tools/node_modules/.bin:/usr/bin", HOME: "/home/pwuser", CI: "1", NEXT_TELEMETRY_DISABLED: "1" });
  });
  it("rescans mapped component routes and all routes for shared layouts or new unmapped files", () => {
    const map = { "components/Button.tsx": ["/", "/settings"], "app/other/page.tsx": ["/other"] };
    expect(sourceRoutesForChanges(["components/Button.tsx"], map, ["/", "/settings", "/other"])).toEqual(["/", "/settings"]);
    expect(sourceRoutesForChanges(["app/layout.tsx"], map, ["/", "/other"])).toEqual(["/", "/other"]);
    expect(sourceRoutesForChanges(["components/New.tsx"], map, ["/", "/other"])).toEqual(["/", "/other"]);
  });
});
