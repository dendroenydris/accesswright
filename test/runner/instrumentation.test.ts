import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { instrumentNextWorkspace } from "../../src/runner/instrumentation.js";

describe("instrumentNextWorkspace", () => {
  it("adds a sandbox-only Next config using the pinned code-inspector Turbopack rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "accesswright-instrument-"));
    const path = await instrumentNextWorkspace(root);
    const config = await readFile(path, "utf8");

    expect(path).toBe(join(root, "next.config.mjs"));
    expect(config).toContain('from "code-inspector-plugin"');
    expect(config).toContain('bundler: "turbopack"');
    expect(config).toContain("turbopack");
  });

  it("does not overwrite an existing Next config", async () => {
    const root = await mkdtemp(join(tmpdir(), "accesswright-instrument-"));
    await writeFile(join(root, "next.config.mjs"), "export default {};\n");

    await expect(instrumentNextWorkspace(root)).rejects.toThrow(/existing Next config/i);
    expect(await readFile(join(root, "next.config.mjs"), "utf8")).toBe("export default {};\n");
  });
});
