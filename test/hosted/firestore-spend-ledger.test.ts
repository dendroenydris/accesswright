import { expect, it } from "vitest";
import { z } from "zod";
import { FirestoreSpendLedger } from "../../src/hosted/firestore-spend-ledger.js";
import { DurableBudgetProvider } from "../../src/llm/durable-provider.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";
import { createFakeFirestore } from "../helpers/fake-firestore.js";

const model = { provider: "openai" as const, id: "fixture-model" };
const request = { taskType: "fixture", model, prompt: "Private source must not be retained", maxOutputTokens: 100 };
const pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 1 };
const response = { object: { value: "fixture" }, usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.00003 } };

async function fixture(maxUsd = 1) {
  const cloud = createFakeFirestore("accesswrightSpend");
  const options = { ...cloud.options, budgetId: "project-budget" };
  const ledger = await FirestoreSpendLedger.initialize(options, { maxUsd, history: [] });
  return { ...cloud, options, ledger };
}

it("preserves cumulative caps, claims and usage across independent service restarts", async () => {
  const f = await fixture();
  const id = await f.ledger.reserve("fixture-model", 0.8, "a".repeat(64));
  const other = await FirestoreSpendLedger.open(f.options);
  expect(await other.snapshot()).toMatchObject({ maxUsd: 1, pendingAttempts: 1, committedUsd: 0.8 });
  await expect(other.reserve("fixture-model", 0.3, "b".repeat(64))).rejects.toThrow(/budget/i);
  await other.settle(id, { inputTokens: 10, outputTokens: 20, costUsd: 0.1 });
  expect(await f.ledger.snapshot()).toMatchObject({ pendingAttempts: 0, settledAttempts: 1, reservedUsd: 0, settledUsd: 0.1 });
  await expect(f.ledger.settle(id, response.usage)).rejects.toThrow(/already settled/i);
  await expect(FirestoreSpendLedger.initialize(f.options, { maxUsd: 100, history: [] })).rejects.toThrow(/conflict|exists/i);
});

it("atomically reserves across replicas before allowing either fake provider to run", async () => {
  const f = await fixture(0.15);
  const other = await FirestoreSpendLedger.open(f.options);
  const fake = new FakeLlmProvider([response, response]);
  const providers = [f.ledger, other].map(ledger => new DurableBudgetProvider(fake, { ledger, model, pricing, maxInputTokens: 100000 }));
  const outcomes = await Promise.allSettled(providers.map(provider => provider.generateObject(request, z.object({ value: z.string() }))));
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(fake.requests).toHaveLength(1);
  expect(f.records.size).toBe(2);
  expect(await other.snapshot()).toMatchObject({ settledAttempts: 1, pendingAttempts: 0, settledUsd: 0.00003 });
  expect(JSON.stringify([...f.records.values()])).not.toContain(request.prompt);
  expect(JSON.stringify([...f.records.values()])).not.toContain("local-fixture-identity");
});

it("retains unknown usage until actual accounting resolves that exact reservation", async () => {
  const f = await fixture(0.15);
  const fake = new FakeLlmProvider([{ error: new Error("Fixture transport timeout") }]);
  const provider = new DurableBudgetProvider(fake, { ledger: f.ledger, model, pricing, maxInputTokens: 100000 });
  await expect(provider.generateObject(request, z.object({ value: z.string() }))).rejects.toThrow("Fixture transport timeout");
  const other = await FirestoreSpendLedger.open(f.options);
  expect(await other.snapshot()).toMatchObject({ pendingAttempts: 0, unknownAttempts: 1, reservedUsd: 0.1001 });
  await expect(other.reserve("fixture-model", 0.1, "b".repeat(64))).rejects.toThrow(/budget/i);
  const id = [...f.records.keys()].find(key => key !== f.options.budgetId);
  if (!id) throw new Error("Expected the retained reservation");
  await other.recordUnknown(id);
  expect((await other.snapshot()).unknownAttempts).toBe(1);
  await other.settle(id, response.usage);
  expect(await f.ledger.snapshot()).toMatchObject({ unknownAttempts: 0, settledAttempts: 1, reservedUsd: 0 });
});

it("keeps a committed reservation when its response is lost and never calls the provider", async () => {
  const cloud = createFakeFirestore("accesswrightSpend");
  const fetcher: typeof fetch = async (input, init) => {
    const result = await cloud.fetcher(input, init);
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    return init?.method === "POST" && url.endsWith(":commit") ? new Response("private-source-leak", { status: 503 }) : result;
  };
  const options = { ...cloud.options, fetcher, budgetId: "project-budget" };
  const ledger = await FirestoreSpendLedger.initialize(options, { maxUsd: 0.15, history: [] });
  const fake = new FakeLlmProvider([response]);
  const provider = new DurableBudgetProvider(fake, { ledger, model, pricing, maxInputTokens: 100000 });
  await expect(provider.generateObject(request, z.object({ value: z.string() }))).rejects.toThrow(/commit failed/);
  expect(fake.requests).toHaveLength(0);
  const other = await FirestoreSpendLedger.open({ ...options, fetcher: cloud.fetcher });
  expect(await other.snapshot()).toMatchObject({ pendingAttempts: 1, reservedUsd: 0.1001 });
  await expect(other.reserve("fixture-model", 0.1, "b".repeat(64))).rejects.toThrow(/budget/i);
});

it("persists overspend and blocks future calls instead of discarding the evidence", async () => {
  const f = await fixture();
  const id = await f.ledger.reserve("fixture-model", 0.1, "a".repeat(64));
  await expect(f.ledger.settle(id, { inputTokens: 10, outputTokens: 20, costUsd: 0.2 })).rejects.toThrow(/reservation/);
  const other = await FirestoreSpendLedger.open(f.options);
  expect(await other.snapshot()).toMatchObject({ blocked: true, settledUsd: 0.2, settledAttempts: 1, pendingAttempts: 0 });
  await expect(other.reserve("fixture-model", 0.01, "b".repeat(64))).rejects.toThrow(/reconciliation/);
});

it.each(["before", "after"] as const)("retains accounting when settlement fails %s the server commit", async phase => {
  const cloud = createFakeFirestore("accesswrightSpend");
  let commits = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const fail = init?.method === "POST" && url.endsWith(":commit") && ++commits === 2;
    if (fail && phase === "before") return new Response("private-source-leak", { status: 503 });
    const result = await cloud.fetcher(input, init);
    return fail ? new Response("private-source-leak", { status: 503 }) : result;
  };
  const options = { ...cloud.options, fetcher, budgetId: "project-budget" };
  const ledger = await FirestoreSpendLedger.initialize(options, { maxUsd: 0.15, history: [] });
  const fake = new FakeLlmProvider([response]);
  const provider = new DurableBudgetProvider(fake, { ledger, model, pricing, maxInputTokens: 100000 });
  await expect(provider.generateObject(request, z.object({ value: z.string() }))).rejects.toThrow(/commit failed/);
  expect(fake.requests).toHaveLength(1);
  const other = await FirestoreSpendLedger.open({ ...options, fetcher: cloud.fetcher });
  expect(await other.snapshot()).toMatchObject(phase === "before" ? { pendingAttempts: 1, reservedUsd: 0.1001, settledUsd: 0 } :
    { pendingAttempts: 0, reservedUsd: 0, settledUsd: 0.00003 });
});

it("releases only the exact settled reservations without leaving floating-point allowance behind", async () => {
  const f = await fixture();
  const first = await f.ledger.reserve("fixture-model", 0.1, "a".repeat(64));
  const second = await f.ledger.reserve("fixture-model", 0.2, "b".repeat(64));
  await f.ledger.settle(first, { inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
  expect((await f.ledger.snapshot()).reservedUsd).toBeCloseTo(0.2, 10);
  await f.ledger.settle(second, { inputTokens: 1, outputTokens: 1, costUsd: 0.02 });
  expect(await f.ledger.snapshot()).toMatchObject({ pendingAttempts: 0, reservedUsd: 0, settledAttempts: 2 });
});

it("keeps the budget document bounded while retaining each settled call as metadata", async () => {
  const f = await fixture();
  for (let index = 0; index < 75; index += 1) {
    const id = await f.ledger.reserve("fixture-model", 0.1, "a".repeat(64));
    await f.ledger.settle(id, { inputTokens: 1, outputTokens: 1, costUsd: 0.001 });
  }
  expect(f.records.size).toBe(76);
  expect(f.records.get(f.options.budgetId)?.payload.length).toBeLessThan(1024);
  expect(await f.ledger.snapshot()).toMatchObject({ settledAttempts: 75, pendingAttempts: 0, reservedUsd: 0 });
  expect((await f.ledger.snapshot()).settledUsd).toBeCloseTo(0.075, 10);
});

it("rejects missing or malformed budgets and reservations belonging to another allowance", async () => {
  const cloud = createFakeFirestore("accesswrightSpend");
  const options = { ...cloud.options, budgetId: "original-budget" };
  await expect(FirestoreSpendLedger.open(options)).rejects.toThrow(/absent/);
  const ledger = await FirestoreSpendLedger.initialize(options, { maxUsd: 1,
    history: [{ id: "prior-unknown", upperBoundUsd: 0.2, note: "Conservative upper bound" }] });
  expect((await ledger.snapshot()).historyUpperBoundUsd).toBe(0.2);
  const id = await ledger.reserve("fixture-model", 0.1, "a".repeat(64));
  const other = await FirestoreSpendLedger.initialize({ ...options, budgetId: "other-budget" }, { maxUsd: 1, history: [] });
  await expect(other.settle(id, response.usage)).rejects.toThrow(/Unknown budget/);
  const saved = cloud.records.get("original-budget");
  if (!saved) throw new Error("Expected stored budget metadata");
  cloud.records.set("original-budget", { ...saved, payload: JSON.stringify({ ...JSON.parse(saved.payload), rawSource: "must reject" }) });
  await expect(FirestoreSpendLedger.open(options)).rejects.toThrow();
});
