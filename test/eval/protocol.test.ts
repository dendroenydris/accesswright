import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { EvalProtocolSchema, freezeProtocol, readFrozenProtocol, systemPolicy } from "../../src/eval/protocol.js";

const protocol = { version: 1, corpus: "public-nextjs", frozenAt: "2026-10-07T00:00:00.000Z", selection: "Permissive-license Next 15/16 repositories selected before repair outcomes", repositories: [{ repository: "owner/dev", sha: "a".repeat(40), license: "MIT", split: "dev" }, { repository: "owner/test", sha: "b".repeat(40), license: "MIT", split: "test" }], model: { provider: "openai", id: "fixture-model", reasoningEffort: "high" }, operators: ["invalid-aria", "positive-tabindex"], systems: ["A", "A1", "B1", "deterministic"], seeds: { dev: [1], test: [1, 2, 3] }, maxCasesPerRepository: 30, targetTestCases: 300 };

it("freezes exact commits, disjoint repository splits and unique seeds", () => {
  expect(EvalProtocolSchema.parse(protocol).repositories).toHaveLength(2);
  expect(() => EvalProtocolSchema.parse({ ...protocol, repositories: [...protocol.repositories, { ...protocol.repositories[0], split: "test" }] })).toThrow();
  expect(() => EvalProtocolSchema.parse({ ...protocol, repositories: [{ ...protocol.repositories[0], sha: "main" }] })).toThrow();
  expect(() => EvalProtocolSchema.parse({ ...protocol, seeds: { dev: [1], test: [1, 1] } })).toThrow();
});
it("defines A1 as one-attempt full context and B1 as suggest-only, not as no-LLM", () => {
  expect(systemPolicy("A1")).toEqual({ attempts: 1, usesLlm: true, enrichedContext: true, verificationFeedback: false, deterministicFirst: true });
  expect(systemPolicy("B1")).toEqual({ attempts: 1, usesLlm: true, enrichedContext: false, verificationFeedback: false, deterministicFirst: false });
  expect(systemPolicy("A")).toMatchObject({ attempts: 3, verificationFeedback: true });
  expect(systemPolicy("deterministic").usesLlm).toBe(false);
});
it("refuses overwriting a frozen protocol and detects a changed digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-protocol-"));
  try {
    const path = join(root, "protocol.json");
    const frozen = await freezeProtocol(path, protocol);
    expect(await readFrozenProtocol(path)).toEqual(frozen);
    await expect(freezeProtocol(path, { ...protocol, targetTestCases: 1 })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toContain(frozen.digest);
    await writeFile(path, JSON.stringify({ ...frozen, protocol: { ...frozen.protocol, targetTestCases: 1 } }));
    await expect(readFrozenProtocol(path)).rejects.toThrow(/digest/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("extends the 20261007 corpus without changing its repositories, SHAs or splits", async () => {
  const original = await readFrozenProtocol("eval/protocol-20261007.json");
  const extended = await readFrozenProtocol("eval/protocol-20261012.json");
  for (const repository of original.protocol.repositories) expect(extended.protocol.repositories).toContainEqual(repository);
  expect(extended.protocol.repositories.filter(repository => repository.split === "test")).toHaveLength(40);
  expect(extended.protocol.targetTestCases).toBe(80);
  expect({ ...extended.protocol, frozenAt: "", selection: "", repositories: [], targetTestCases: 0 }).toEqual({ ...original.protocol, frozenAt: "", selection: "", repositories: [], targetTestCases: 0 });
});
