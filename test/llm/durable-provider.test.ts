import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { z } from "zod";
import { DurableSpendLedger } from "../../src/llm/durable-spend.js";
import { DurableBudgetProvider } from "../../src/llm/durable-provider.js";
import { LlmStructuredOutputError } from "../../src/llm/errors.js";
import type { LlmCallRequest, LlmProvider } from "../../src/llm/types.js";

const request: LlmCallRequest = { taskType: "fixture", model: { provider: "openai", id: "fixture-model", reasoningEffort: "high" }, prompt: "private repository excerpt", maxOutputTokens: 100 };
const pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
const schema = z.object({ ok: z.boolean() });

it("persists a pre-call reservation and accounts schema failures as well as successes", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-provider-ledger-"));
  try {
    const ledger = await DurableSpendLedger.initialize(join(root, "spend.json"), { maxUsd: 1, history: [] });
    let calls = 0;
    const inner: LlmProvider = { generateObject: async () => {
      calls += 1;
      expect((await ledger.snapshot()).pendingAttempts).toBe(1);
      if (calls === 1) throw new LlmStructuredOutputError("invalid object", { inputTokens: 10, outputTokens: 5, costUsd: 0.00002 });
      return { object: { ok: true }, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.00002 } };
    } };
    const provider = new DurableBudgetProvider(inner, { ledger, model: request.model, maxInputTokens: 1000, pricing });
    await expect(provider.generateObject(request, schema)).rejects.toThrow(/invalid object/);
    await expect(provider.generateObject(request, schema)).resolves.toMatchObject({ object: { ok: true } });
    expect(await ledger.snapshot()).toMatchObject({ pendingAttempts: 0, unknownAttempts: 0, settledAttempts: 2, settledUsd: 0.00004 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("never starts transport on exhausted allowance or an unpriced model substitution", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-provider-cap-"));
  try {
    const ledger = await DurableSpendLedger.initialize(join(root, "spend.json"), { maxUsd: 0.0001, history: [] });
    let calls = 0;
    const inner: LlmProvider = { generateObject: () => { calls += 1; throw new Error("Transport must not run"); } };
    const provider = new DurableBudgetProvider(inner, { ledger, model: request.model, maxInputTokens: 1000, pricing });
    await expect(provider.generateObject(request, schema)).rejects.toThrow(/budget/i);
    await expect(provider.generateObject({ ...request, model: { ...request.model, id: "unpriced-model" } }, schema)).rejects.toThrow(/model/i);
    expect(calls).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("retains a conservative reservation on an ambiguous transport failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-provider-unknown-"));
  try {
    const ledger = await DurableSpendLedger.initialize(join(root, "spend.json"), { maxUsd: 1, history: [] });
    const provider = new DurableBudgetProvider({ generateObject: () => Promise.reject(new Error("network response lost")) }, { ledger, model: request.model, maxInputTokens: 1000, pricing });
    await expect(provider.generateObject(request, schema)).rejects.toThrow(/network response lost/);
    const snapshot = await ledger.snapshot();
    expect(snapshot.unknownAttempts).toBe(1);
    expect(snapshot.reservedUsd).toBeCloseTo(0.0012);
    expect(snapshot.settledUsd).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
