import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { repairRepository } from "../../src/core/repository.js";
import { DurableSpendLedger } from "../../src/llm/durable-spend.js";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";
import { parseLiveAuthorization } from "../helpers/live-authorization.js";
import { assertSaveButtonEvidence } from "../helpers/semantic-evidence.js";

const live = process.env.ACCESSWRIGHT_LIVE_BROWSER === "1" ? it : it.skip;

live("verifies an actual provider repair in Next.js production using browser axe, unchanged node identity, and frozen semantic ground truth", async () => {
  const configPath = process.env.ACCESSWRIGHT_LIVE_AUTHORIZATION;
  if (!configPath) throw new Error("Explicit dated live authorization is required; ordinary CI never supplies it");
  const authorization = parseLiveAuthorization(JSON.parse(await readFile(configPath, "utf8")));
  const ledger = await DurableSpendLedger.open(authorization.ledgerPath);
  const start = await ledger.snapshot();
  if (start.blocked || start.remainingUsd <= 0) throw new Error("Cumulative project allowance is not available");
  const key = process.env.OPENAI_API_KEY;
  if (!key?.trim()) throw new Error("OPENAI_API_KEY is missing in the coordinator environment");
  // Read-only authentication immediately before this run; no alternate endpoint or credential file.
  const response = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenAI model authentication failed: HTTP ${response.status}`); }
  const models = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await response.json());
  if (!models.data.some(model => model.id === authorization.model)) throw new Error("The explicitly priced design model is unavailable");
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
  await mkdir(tempRoot, { recursive: true });
  const fixture = await mkdtemp(join(tempRoot, "live-semantic-fixture-"));
  await createNextIntegrationFixture(fixture);
  await writeFile(join(fixture, ".accesswright.yml"), `model:\n  provider: openai\n  id: ${authorization.model}\n  reasoningEffort: high\nscan:\n  mobile: true\n`);
  const result = await repairRepository({ repoPath: fixture, tempRoot, runtimeRoot: process.cwd(), offline: true, retainEvidence: true,
    maxCostUsd: authorization.maxRunCostUsd, pricing: authorization.pricing,
    durableBudget: { ledger, maxInputTokens: authorization.maxInputTokens, expiresAt: authorization.expiresAt } });
  await writeFile(join(result.evidenceDir, "live-metadata.json"), JSON.stringify({ date: new Date().toISOString(), model: authorization.model, reasoningEffort: "high", costBasis: authorization.costBasis,
    pricing: authorization.pricing, pricingSource: authorization.pricingSource, globalBudget: await ledger.snapshot(), report: result.report }, null, 2), { mode: 0o600 });
  console.log(`Actual OpenAI + Next.js + browser evidence: ${result.evidenceDir}`);
  expect(result.report, JSON.stringify(result.report)).toMatchObject({ status: "verified", fixed: 3, applied: true, providerVerification: "provider-api", unknownUsage: false });
  expect(result.report.checks.map(check => check.status)).toEqual(["passed", "passed", "passed", "passed"]);
  expect(result.report.usage.inputTokens).toBeGreaterThan(0);
  expect(result.report.usage.outputTokens).toBeGreaterThan(0);
  expect(result.report.usage.spentUsd).toBeLessThanOrEqual(authorization.maxRunCostUsd);
  await assertSaveButtonEvidence(result.evidenceDir);
  expect((await ledger.snapshot()).pendingAttempts).toBe(start.pendingAttempts);
});
