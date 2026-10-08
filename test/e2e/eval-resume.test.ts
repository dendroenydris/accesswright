import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { runEvaluation } from "../../src/eval/runner.js";
import { EvalProtocolSchema } from "../../src/eval/protocol.js";

it("resumes a partial frozen evaluation without repeating already persisted failed preparation cells", async () => {
  const root = await mkdtemp(join(process.env.ACCESSWRIGHT_TMP_ROOT ?? tmpdir(), "aw-resume-real-"));
  try {
    const source = join(root, "fixture");
    const output = join(root, "output");
    await mkdir(source);
    await writeFile(join(source, "README.md"), "fixture without package manifest\n");
    const protocol = EvalProtocolSchema.parse({
      version: 1,
      corpus: "controlled-fixtures",
      frozenAt: "2026-10-08T00:00:00.000Z",
      selection: "fixed original, no source retries",
      repositories: [{ repository: "owner/frozen", sha: "a".repeat(40), license: "MIT", split: "dev" }],
      model: { provider: "openai", id: "fixture-only" },
      operators: ["invalid-aria"],
      systems: ["deterministic"],
      seeds: { dev: [1], test: [1] },
      maxCasesPerRepository: 1,
      targetTestCases: 300,
    });
    const options = {
      frozen: { protocol, digest: createHash("sha256").update(JSON.stringify(protocol)).digest("hex") },
      runtimeRoot: process.cwd(),
      tempRoot: join(root, "temp"),
      outputDir: output,
      cacheRoot: join(root, "cache"),
      fixtureRoots: { "owner/frozen": source },
      split: "dev" as const,
      systems: ["deterministic" as const],
      seeds: [1],
      caseLimit: 1,
    };
    const first = await runEvaluation(options);
    expect(first.cells).toHaveLength(1);
    expect(first.cells[0]?.status).toBe("blocked");
    await unlink(join(output, "summary.json"));
    await unlink(join(output, "report.md"));
    const resumed = await runEvaluation({ ...options, resume: true });
    expect(resumed.cells).toHaveLength(1);
    expect(resumed.cells[0]).toEqual(first.cells[0]);
    expect(resumed.summary.groups[0]?.blockedCells).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
