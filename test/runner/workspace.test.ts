import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDisposableWorkspace } from "../../src/runner/workspace.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("createDisposableWorkspace", () => {
  it("copies source files, excludes build/install artifacts, and instruments only the copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "accesswright-workspace-"));
    const source = join(root, "fixture");
    const tempRoot = join(root, "build");
    await mkdir(join(source, "app"), { recursive: true });
    await mkdir(join(source, "node_modules", "ignored"), { recursive: true });
    await mkdir(join(source, ".next", "cache"), { recursive: true });
    await writeFile(join(source, "package.json"), '{"name":"fixture"}\n');
    await writeFile(join(source, "app", "page.tsx"), "export default function Page() {}\n");
    await writeFile(join(source, "._package.json"), "apple-double\n");
    await writeFile(join(source, ".DS_Store"), "finder\n");
    await writeFile(join(source, ".env.local"), "PRIVATE_VALUE=fixture-only\n");
    await writeFile(join(source, ".npmrc"), "//registry.example:_authToken=fixture-only\n");
    await writeFile(join(source, "node_modules", "ignored", "file"), "ignored\n");
    await writeFile(join(source, ".next", "cache", "file"), "ignored\n");

    const workspace = await createDisposableWorkspace(source, tempRoot, "file:///plugin.mjs");

    expect(await readFile(join(workspace, "package.json"), "utf8")).toContain("fixture");
    expect(await readFile(join(workspace, "app", "page.tsx"), "utf8")).toContain("Page");
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
    expect(await exists(join(workspace, ".next"))).toBe(false);
    expect(await exists(join(workspace, "._package.json"))).toBe(false);
    expect(await exists(join(workspace, ".DS_Store"))).toBe(false);
    expect(await exists(join(workspace, ".env.local"))).toBe(false);
    expect(await exists(join(workspace, ".npmrc"))).toBe(false);
    expect(await readFile(join(workspace, "next.config.mjs"), "utf8")).toContain(
      "file:///plugin.mjs",
    );
    expect(await exists(join(source, "next.config.mjs"))).toBe(false);
  });
});
