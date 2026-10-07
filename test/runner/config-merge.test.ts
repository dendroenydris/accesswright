import { describe, expect, it } from "vitest";
import { withSourceMapping, instrumentConfigSource } from "../../src/runner/config-merge.js";

const plugins = { turbopack: { "*.tsx": { loaders: ["inspector"], as: "*.js" } }, webpack: { name: "inspector" } };
describe("sandbox-only instrumentation preserves the original configuration", () => {
  it("merges existing Turbopack loaders without discarding options", () => {
    const original = { reactStrictMode: true, turbopack: { root: "/workspace", rules: { "*.tsx": { loaders: ["existing"], as: "*.js" }, "*.svg": { loaders: ["svg-loader"] } } } };
    const merged = withSourceMapping(original, plugins, "16.3.8");
    expect(merged).toMatchObject({ reactStrictMode: true, turbopack: { root: "/workspace", rules: { "*.tsx": { loaders: ["existing", "inspector"], as: "*.js" }, "*.svg": { loaders: ["svg-loader"] } } } });
    expect(original.turbopack.rules["*.tsx"].loaders).toEqual(["existing"]);
  });
  it("preserves functional configurations and their phase argument", async () => {
    const original = (phase: string) => Promise.resolve({ env: { PHASE: phase } });
    const merged = withSourceMapping(original, plugins, "15.5.27");
    if (typeof merged !== "function") throw new Error("Expected a config function");
    expect(await Reflect.apply(merged, undefined, ["phase-development-server", {}])).toMatchObject({ env: { PHASE: "phase-development-server" }, turbopack: { rules: plugins.turbopack } });
  });
  it("keeps an existing webpack hook and appends the source-mapping plugin", () => {
    const merged = withSourceMapping({ webpack: (config: { plugins: unknown[] }) => ({ ...config, resolve: { alias: { original: "kept" } } }) }, plugins, "16.3.8");
    if (typeof merged !== "object" || merged === null || !("webpack" in merged) || typeof merged.webpack !== "function") throw new Error("Expected webpack hook");
    expect(Reflect.apply(merged.webpack, null, [{ plugins: ["original"] }, {}])).toEqual({ plugins: ["original", plugins.webpack], resolve: { alias: { original: "kept" } } });
  });
  it("uses the historical experimental.turbo slot on Next 15.2", () => {
    expect(withSourceMapping({}, plugins, "15.2.4")).toMatchObject({ experimental: { turbo: { rules: plugins.turbopack } } });
  });
  it("refuses to overwrite a conflicting output type or disabled rule", () => {
    expect(() => withSourceMapping({ turbopack: { rules: { "*.tsx": { loaders: [], as: "*.html" } } } }, plugins, "16.3.8")).toThrow(/conflict/i);
    expect(() => withSourceMapping({ turbopack: { rules: { "*.tsx": false } } }, plugins, "16.3.8")).toThrow(/conflict/i);
  });
  it.each([
    ["next.config.mjs", "export default { reactStrictMode: true };", "module"],
    ["next.config.js", "module.exports = { reactStrictMode: true };", "commonjs"],
    ["next.config.ts", "const config = { reactStrictMode: true }; export default config;", "module"],
    ["next.config.mjs", "export default function configuration(phase) { return { env: { PHASE: phase } }; }", "module"],
  ])("rewrites only the export wrapper for %s", (file, source, moduleKind) => {
    const output = instrumentConfigSource(source, file, moduleKind === "module", "16.3.8");
    expect(output).toContain(source.includes("reactStrictMode") ? "reactStrictMode" : "PHASE");
    expect(output).toContain("withSourceMapping");
    expect(output).toContain("code-inspector-plugin");
    expect(output).not.toContain("await import");
  });
  it("does not guess when a configuration has no identifiable export", () => {
    expect(() => instrumentConfigSource("const config = {};", "next.config.mjs", true, "16.3.8")).toThrow(/export/i);
  });
});
