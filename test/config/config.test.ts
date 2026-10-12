import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, isIgnoredPath } from "../../src/config.js";

const roots: string[] = [];
async function root() { const path = await mkdtemp(join(tmpdir(), "aw-config-")); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe("configuration boundary", () => {
  it("loads deterministic defaults without a provider key", async () => {
    const config = await loadConfig(await root());
    expect(config.scan.mobile).toBe(true);
    expect(config.model).toBeUndefined();
    expect(config.scan.ibm).toBeUndefined();
    expect(config.scan.keyboard).toBeUndefined();
  });
  it("enables the second checker only with a boolean operator flag", async () => {
    const dir = await root();
    await writeFile(join(dir, ".accesswright.yml"), "scan: {ibm: true}\n");
    expect((await loadConfig(dir)).scan.ibm).toBe(true);
    await writeFile(join(dir, ".accesswright.yml"), "scan: {ibm: enabled}\n");
    await expect(loadConfig(dir)).rejects.toThrow();
  });
  it("loads actual YAML and overrides with explicit CLI options", async () => {
    const dir = await root();
    await writeFile(join(dir, ".accesswright.yml"), "routes:\n  - /posts/one\nscan:\n  mobile: false\nmaxCostUsd: 0.5\n");
    const config = await loadConfig(dir, { offline: true });
    expect(config).toMatchObject({ routes: ["/posts/one"], scan: { mobile: false }, maxCostUsd: 0.5, offline: true });
  });
  it("enables keyboard metadata only with an explicit boolean flag", async () => {
    const dir = await root();await writeFile(join(dir, ".accesswright.yml"), "scan: {keyboard: true}\n");
    expect((await loadConfig(dir)).scan.keyboard).toBe(true);
    await writeFile(join(dir, ".accesswright.yml"), "scan: {keyboard: enabled}\n");await expect(loadConfig(dir)).rejects.toThrow();
  });
  it.each(["routes: [//evil.example]", "routes: ['/\\\\evil.example']", "unknown: true", "scan: {mobile: yes}", "routes: [/]\nroutes: [/other]"])("rejects unsafe or ambiguous configuration: %s", async (text) => {
    const dir = await root(); await writeFile(join(dir, ".accesswright.yml"), text);
    await expect(loadConfig(dir)).rejects.toThrow();
  });
  it("matches explicit ignored paths without matching adjacent directories", () => {
    expect(isIgnoredPath("src/private/Button.tsx", ["src/private/**"])).toBe(true);
    expect(isIgnoredPath("src/private-other/Button.tsx", ["src/private/**"])).toBe(false);
  });
});
