import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";

async function dependencyManifest(require: NodeRequire, name: string): Promise<string> {
  for (const root of require.resolve.paths(name) ?? []) {
    try { return await realpath(join(root, name, "package.json")); }
    catch (error) {
      if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))) continue;
      throw error;
    }
  }
  throw new Error("Trusted runtime dependency metadata is missing");
}

/** Mount a complete dependency tree with the same module identities as the trusted host runtime. */
export async function resolveRuntimeDependencies(runtimeRoot: string): Promise<string> {
  const manifest = join(runtimeRoot, "package.json");
  const { dependencies } = z.object({ dependencies: z.record(z.string(), z.string()) }).parse(JSON.parse(await readFile(manifest, "utf8")) as unknown);
  const names = Object.keys(dependencies), require = createRequire(manifest);
  if (!names.length) throw new Error("Trusted runtime dependencies are missing");
  // Package-root resolution also covers import-only exports; it never loads dependency code.
  const expected = await Promise.all(names.map(name => dependencyManifest(require, name)));
  for (const [index, path] of expected.entries()) {
    const metadata = z.object({ name: z.string(), version: z.string() }).parse(JSON.parse(await readFile(path, "utf8")) as unknown);
    if (metadata.name !== names[index] || metadata.version !== dependencies[names[index] ?? ""]) throw new Error("Trusted runtime dependency version does not match the pinned package");
  }
  for (const candidate of require.resolve.paths(names[0] ?? "") ?? []) {
    let root: string;
    try { root = await realpath(candidate); }
    catch (error) {
      if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))) continue;
      throw error;
    }
    const mounted = createRequire(join(dirname(root), "package.json"));
    const resolved = await Promise.all(names.map(async name => {
      try { return await dependencyManifest(mounted, name); } catch { return undefined; }
    }));
    if (resolved.every((file, index) => {
      if (file === undefined || file !== expected[index]) return false;
      const path = relative(root, file);
      return !isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep);
    })) return root;
  }
  throw new Error("Runtime dependencies cannot be mounted consistently; install accesswright in a separate npm directory");
}
