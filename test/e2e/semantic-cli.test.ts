import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";
import { repairRepository } from "../../src/core/repository.js";
import type { LlmProvider } from "../../src/llm/types.js";
import { RunReportSchema } from "../../src/reporter/report.js";

it("repairs a real Next.js semantic target through the coordinator, rejects hiding, and reruns the compiled CLI idempotently", async () => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
  await mkdir(tempRoot,{recursive:true});
  const fixture = await mkdtemp(join(tempRoot,"semantic-fixture-"));
  await createNextIntegrationFixture(fixture);
  await writeFile(join(fixture,".accesswright.yml"), "model:\n  provider: openai\n  id: fixture-provider\n  reasoningEffort: high\nscan:\n  mobile: true\n");
  let calls = 0;
  const provider: LlmProvider = {
    generateObject: request => {
      calls += 1;
      expect(request.images?.[0]?.data.byteLength).toBeGreaterThan(8);
      expect(request.prompt).toContain("Save changes");
      expect(request.prompt).toContain("button-name");
      const marker = /^Task ID: (.+)$/m.exec(request.prompt);
      const taskId = marker?.[1];
      if (!taskId) throw new Error("The actual task ID must be present in the repair prompt");
      const before = '<button id="unlabeled" type="button"';
      const after = calls === 1 ? '<button id="unlabeled" type="button" hidden' : '<button id="unlabeled" type="button" aria-label="Save changes"';
      return Promise.resolve({ object: { taskId, changes: [{ path: "components/Controls.tsx", before, after }] }, usage: { inputTokens: 300, outputTokens: 100, costUsd: 0.0001 } });
    },
  };
  const result = await repairRepository({ repoPath: fixture, tempRoot, runtimeRoot: process.cwd(), offline: true, retainEvidence: true,
    maxCostUsd: 0.1, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, provider });
  expect(calls).toBe(2);
  expect(result.report).toMatchObject({ status: "verified", fixed: 3, applied: true, providerVerification: "fake-provider", unknownUsage: false });
  expect(result.report.checks.map(check => check.status)).toEqual(["passed","passed","passed","passed"]);
  const source = await readFile(join(fixture,"components/Controls.tsx"),"utf8");
  expect(source).toContain('aria-label="Save changes"');
  expect(source).not.toContain("aria-bogus"); expect(source).not.toContain(" hidden");
  expect(result.groups).toHaveLength(3);
  expect(result.groups.every(group => group.perPatchAccepted)).toBe(true);
  const rerun = await execa("node", [join(process.cwd(),"dist/src/cli.js"), "fix", fixture, "--no-llm", "--offline", "--dry-run"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", ACCESSWRIGHT_TMP_ROOT: tempRoot }, extendEnv: false, timeout: 600000,
  });
  const report = RunReportSchema.parse(JSON.parse(rerun.stdout));
  expect(report).toMatchObject({ fixed: 0, status: "verified", applied: false, providerVerification: "not-run" });
  expect(await readFile(join(fixture,"components/Controls.tsx"),"utf8")).toBe(source);
  expect((await readdir(result.evidenceDir)).some(name => name.endsWith(".png"))).toBe(true);
  console.log(`Semantic fake-provider + real Docker + CLI evidence: ${result.evidenceDir}`);
});
