import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { EvalProtocolSchema } from "../../src/eval/protocol.js";
import { evalCellFileName, loadEvalResumeState } from "../../src/eval/resume.js";

const directories: string[] = [];
const protocol = EvalProtocolSchema.parse({
  version: 1, corpus: "public-nextjs", frozenAt: "2026-10-07T00:00:00.000Z",
  selection: "Selected and frozen before repair outcomes",
  repositories: [{ repository: "owner/test", sha: "a".repeat(40), license: "MIT", split: "test" }],
  model: { provider: "openai", id: "fixture-model" },
  operators: ["invalid-aria"], systems: ["deterministic"],
  seeds: { dev: [1], test: [1] }, maxCasesPerRepository: 30, targetTestCases: 300,
});
const frozen = {
  protocol,
  digest: createHash("sha256").update(JSON.stringify(protocol)).digest("hex"),
};
const implementationDigest = "b".repeat(64);
const selection = {
  split: "test" as const,
  systems: ["deterministic" as const],
  seeds: [1],
  repositories: [...protocol.repositories],
};
const cell = {
  schemaVersion: 1,
  protocolDigest: frozen.digest, implementationDigest,
  repository: "owner/test", sha: "a".repeat(40), corpus: "public-nextjs",
  split: "test", seed: 1, batch: 0, system: "deterministic",
  providerEvidence: "not-run", model: protocol.model,
  providerMode: "none",
  startedAt: "2026-10-08T10:00:00.000Z",
  finishedAt: "2026-10-08T10:00:01.000Z",
  durationMs: 1000,
  status: "unsupported", reason: "Original build incompatible",
  cases: [], exclusions: [], verification: [],
  usage: { spentUsd: 0, inputTokens: 0, outputTokens: 0, unknownUsage: false },
  controls: { observed: 0, changed: 0, unexpectedEditedFiles: [] },
  newViolations: 0, report: null, evidenceId: null,
} as const;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aw-eval-resume-"));
  directories.push(root);
  await mkdir(join(root, "runtime"));
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    schemaVersion: 1, protocol: frozen, implementationDigest, runtimeSnapshot: "runtime",
    selection, caseLimit: 4, providerInjection: false, createdAt: "2026-10-08T10:00:00.000Z",
  }));
  await writeFile(join(root, evalCellFileName(cell)), JSON.stringify(cell));
  return {
    root,
    options: { outputDir: root, frozen, implementationDigest, selection, caseLimit: 4, providerInjection: false },
  };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it("recovers unchanged cells without rerunning or overwriting their identities", async () => {
  const { options } = await fixture();
  const recovered = await loadEvalResumeState(options);
  expect(recovered.cells).toHaveLength(1);
  expect(recovered.cells[0]?.status).toBe("unsupported");
  expect(recovered.existingCellFiles.has(evalCellFileName(cell))).toBe(true);
  expect(recovered.references.size).toBe(0);
});

it("fails closed on changed frozen digest, implementation, selected system, or case bound", async () => {
  const { options } = await fixture();
  await expect(loadEvalResumeState({ ...options, implementationDigest: "c".repeat(64) })).rejects.toThrow(/resume/i);
  await expect(loadEvalResumeState({ ...options, caseLimit: 5 })).rejects.toThrow(/resume/i);
  await expect(loadEvalResumeState({ ...options, selection: { ...options.selection, seeds: [2] } })).rejects.toThrow(/resume/i);
});

it("refuses tampered cells or a previously published summary", async () => {
  const { root, options } = await fixture();
  await writeFile(join(root, evalCellFileName(cell)), JSON.stringify({ ...cell, sha: "c".repeat(40) }));
  await expect(loadEvalResumeState(options)).rejects.toThrow(/selection|identity/);
  await writeFile(join(root, evalCellFileName(cell)), JSON.stringify(cell));
  await writeFile(join(root, "summary.json"), "{}");
  await expect(loadEvalResumeState(options)).rejects.toThrow(/completed|published/);
});
