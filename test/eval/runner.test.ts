import { expect, it } from "vitest";
import { resolveEvalSelection, implementationDigest, snapshotCompiledRuntime } from "../../src/eval/runner.js";
import { EvalProtocolSchema } from "../../src/eval/protocol.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const protocol = EvalProtocolSchema.parse({ version: 1, corpus: "public-nextjs", frozenAt: "2026-10-07T00:00:00.000Z", selection: "Fixed before repair outcomes", repositories: [{ repository: "owner/dev", sha: "a".repeat(40), license: "MIT", split: "dev" }, { repository: "owner/test", sha: "b".repeat(40), license: "MIT", split: "test" }], model: { provider: "openai", id: "fixture-model" }, operators: ["invalid-aria"], systems: ["A", "A1", "B1", "deterministic"], seeds: { dev: [1], test: [1, 2, 3] }, maxCasesPerRepository: 30, targetTestCases: 300 });

it("selects only frozen repositories/systems/seeds and preserves explicit partial coverage", () => {
  expect(resolveEvalSelection(protocol, { split: "dev", systems: ["deterministic"] })).toMatchObject({ repositories: [protocol.repositories[0]], seeds: [1], systems: ["deterministic"] });
  expect(() => resolveEvalSelection(protocol, { split: "dev", seeds: [2] })).toThrow(/seed/i);
  expect(() => resolveEvalSelection(protocol, { split: "dev", repositories: ["owner/test"] })).toThrow(/repository/i);
  expect(() => resolveEvalSelection(protocol, { split: "test", systems: ["A", "A"] })).toThrow(/duplicate/i);
});

it("fingerprints executable implementation bytes without machine-specific absolute paths", async () => {
  const a = await mkdtemp(join(tmpdir(), "aw-impl-")), b = await mkdtemp(join(tmpdir(), "aw-impl-"));
  try {
    for (const root of [a, b]) { await mkdir(join(root, "src")); await writeFile(join(root, "src/main.js"), "export const version=1;\n"); }
    expect(await implementationDigest(a)).toBe(await implementationDigest(b));
    await writeFile(join(b, "src/main.js"), "export const version=2;\n");
    expect(await implementationDigest(a)).not.toBe(await implementationDigest(b));
  } finally { await rm(a, { recursive: true, force: true }); await rm(b, { recursive: true, force: true }); }
});

it("freezes compiled evaluation code without copying the dependency tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-runtime-root-"));
  const output = await mkdtemp(join(tmpdir(), "aw-runtime-output-"));
  try {
    await mkdir(join(root, "dist", "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "large-dependency"), { recursive: true });
    await writeFile(join(root, "dist", "src", "main.js"), "export const version=1;\n");
    await writeFile(join(root, "node_modules", "large-dependency", "index.js"), "large dependency placeholder\n");
    const snapshot = await snapshotCompiledRuntime(root, output);
    expect(snapshot.digest).toBe(await implementationDigest(snapshot.path));
    await writeFile(join(root, "dist", "src", "main.js"), "export const version=2;\n");
    expect(await implementationDigest(snapshot.path)).toBe(snapshot.digest);
    await expect(readFile(join(snapshot.path, "node_modules", "large-dependency", "index.js"), "utf8")).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
});
