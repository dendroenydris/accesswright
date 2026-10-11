import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveRuntimeDependencies } from "../../src/runner/runtime-dependencies.js";

async function dependency(root: string, name: string) {
  const path = join(root, name); await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
  await writeFile(join(path, "index.js"), 'throw new Error("Dependency must never be executed during resolution");\n');
}

it.each(["local", "hoisted", "mounted-symlink"])("resolves the complete %s npm dependency tree without loading its code", async layout => {
  const root = await mkdtemp(join(tmpdir(), "aw-runtime-dependencies-"));
  try {
    const runtime = layout === "hoisted" ? join(root, "node_modules/accesswright") : join(root, "runtime");
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "package.json"), JSON.stringify({ dependencies: { first: "1.0.0", second: "1.0.0" } }));
    const modules = layout === "local" ? join(runtime, "node_modules") : join(root, "node_modules");
    await dependency(modules, "first"); await dependency(modules, "second");
    if (layout === "mounted-symlink") await symlink(modules, join(runtime, "node_modules"));
    expect(await resolveRuntimeDependencies(runtime)).toBe(await realpath(modules));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("refuses a split layout rather than loading a different hoisted dependency in Docker", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-runtime-split-")), runtime = join(root, "node_modules/accesswright");
  try {
    await mkdir(runtime, { recursive: true }); await writeFile(join(runtime, "package.json"), JSON.stringify({ dependencies: { first: "1.0.0", second: "1.0.0" } }));
    await dependency(join(root, "node_modules"), "first"); await dependency(join(root, "node_modules"), "second");
    await dependency(join(runtime, "node_modules"), "second");
    await expect(resolveRuntimeDependencies(runtime)).rejects.toThrow("mounted consistently");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("supports import-only package exports without using CommonJS entry resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-runtime-import-only-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { first: "1.0.0" } }));
    await dependency(join(root, "node_modules"), "first");
    await writeFile(join(root, "node_modules/first/package.json"), JSON.stringify({ name: "first", version: "1.0.0", exports: { import: "./index.js" } }));
    expect(await resolveRuntimeDependencies(root)).toBe(await realpath(join(root, "node_modules")));
    await writeFile(join(root, "node_modules/first/package.json"), JSON.stringify({ name: "first", version: "2.0.0", main: "index.js" }));
    await expect(resolveRuntimeDependencies(root)).rejects.toThrow("pinned package");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("refuses linked dependency code outside the read-only mounted tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-runtime-link-")), runtime = join(root, "runtime");
  try {
    await mkdir(join(runtime, "node_modules"), { recursive: true }); await writeFile(join(runtime, "package.json"), JSON.stringify({ dependencies: { first: "1.0.0" } }));
    await dependency(join(root, "outside"), "first"); await symlink(join(root, "outside/first"), join(runtime, "node_modules/first"));
    await expect(resolveRuntimeDependencies(runtime)).rejects.toThrow("mounted consistently");
  } finally { await rm(root, { recursive: true, force: true }); }
});
