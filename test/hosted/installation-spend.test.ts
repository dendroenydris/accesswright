import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { FirestoreSpendLedger, openMonthlyHostedSpend } from "../../src/hosted/firestore-spend-ledger.js";
import { HostedPatchAgent } from "../../src/hosted/agent-api.js";
import { InMemoryHostedAgentRunStore } from "../../src/hosted/agent-run-store.js";
import { DurableBudgetProvider } from "../../src/llm/durable-provider.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";
import { createFakeFirestore } from "../helpers/fake-firestore.js";

const model = { provider: "openai" as const, id: "fixture-model" };
const request = { taskType: "fixture", model, prompt: "private source", maxOutputTokens: 100 };
const pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 1 };
const usage = { inputTokens: 10, outputTokens: 20, costUsd: 0.00003 };
const response = { object: { value: "fixture" }, usage };
afterEach(() => { vi.useRealTimers(); });

async function fixture(globalMax = 1, fetcher?: typeof fetch) {
  const cloud = createFakeFirestore("installationSpend");
  const options = { ...cloud.options, ...(fetcher ? { fetcher } : {}), budgetId: "global-month" };
  const global = await FirestoreSpendLedger.initialize(options, { maxUsd: globalMax, history: [] });
  const installation = await FirestoreSpendLedger.initialize({ ...options, budgetId: "installation-month" }, { maxUsd: 0.3, history: [] });
  const scopedOptions = { ...options, installationBudgetId: "installation-month" };
  const scoped = await FirestoreSpendLedger.open(scopedOptions);
  return { ...cloud, options, scopedOptions, global, installation, scoped };
}

it("claims and settles the same call against both global and installation allowances", async () => {
  const f = await fixture();
  const id = await f.scoped.reserve("fixture", 0.2, "a".repeat(64));
  for (const ledger of [f.global, f.installation]) expect(await ledger.snapshot()).toMatchObject({ pendingAttempts: 1, reservedUsd: 0.2 });
  await expect(f.scoped.reserve("fixture", 0.2, "b".repeat(64))).rejects.toThrow(/budget/i);
  expect(f.records.size).toBe(3);
  await expect(f.global.settle(id, usage)).rejects.toThrow(/Unknown budget/);
  await f.scoped.settle(id, usage);
  for (const ledger of [f.global, f.installation]) expect(await ledger.snapshot()).toMatchObject({ pendingAttempts: 0, settledAttempts: 1, settledUsd: usage.costUsd });
  expect(await f.scoped.snapshot()).toMatchObject({ maxUsd: 0.3, remainingUsd: 0.3 - usage.costUsd });
});

it("prevents different installations from racing past their shared global cap", async () => {
  const f = await fixture(0.15);
  await FirestoreSpendLedger.initialize({ ...f.options, budgetId: "other-installation-month" }, { maxUsd: 0.3, history: [] });
  const other = await FirestoreSpendLedger.open({ ...f.options, installationBudgetId: "other-installation-month" });
  const fake = new FakeLlmProvider([response, response]);
  const providers = [f.scoped, other].map(ledger => new DurableBudgetProvider(fake, { ledger, model, pricing, maxInputTokens: 100000 }));
  const outcomes = await Promise.allSettled(providers.map(provider => provider.generateObject(request, z.object({ value: z.string() }))));
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(fake.requests).toHaveLength(1);
  expect((await f.global.snapshot()).settledAttempts).toBe(1);
  expect(f.records.size).toBe(4);
});

it("retains unknown usage in both scopes and rejects a different installation's settlement", async () => {
  const f = await fixture();
  const id = await f.scoped.reserve("fixture", 0.2, "a".repeat(64));
  await f.scoped.recordUnknown(id);
  const restarted = await FirestoreSpendLedger.open(f.scopedOptions);
  for (const ledger of [f.global, f.installation, restarted]) expect(await ledger.snapshot()).toMatchObject({ pendingAttempts: 0, unknownAttempts: 1, reservedUsd: 0.2 });
  await FirestoreSpendLedger.initialize({ ...f.options, budgetId: "other-installation-month" }, { maxUsd: 0.3, history: [] });
  const other = await FirestoreSpendLedger.open({ ...f.options, installationBudgetId: "other-installation-month" });
  await expect(other.settle(id, usage)).rejects.toThrow(/Unknown budget/);
  await restarted.settle(id, usage);
  for (const ledger of [f.global, f.installation]) expect(await ledger.snapshot()).toMatchObject({ unknownAttempts: 0, reservedUsd: 0, settledAttempts: 1 });
});

it.each(["before", "after"] as const)("keeps both scopes consistent when settlement fails %s the atomic commit", async phase => {
  const cloud = createFakeFirestore("installationSpend");
  let commits = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const fail = init?.method === "POST" && url.endsWith(":commit") && ++commits === 2;
    if (fail && phase === "before") return new Response(null, { status: 503 });
    const result = await cloud.fetcher(input, init);
    return fail ? new Response(null, { status: 503 }) : result;
  };
  const options = { ...cloud.options, fetcher, budgetId: "global-month" };
  await FirestoreSpendLedger.initialize(options, { maxUsd: 1, history: [] });
  await FirestoreSpendLedger.initialize({ ...options, budgetId: "installation-month" }, { maxUsd: 0.3, history: [] });
  const scoped = await FirestoreSpendLedger.open({ ...options, installationBudgetId: "installation-month" });
  const fake = new FakeLlmProvider([response]);
  const provider = new DurableBudgetProvider(fake, { ledger: scoped, model, pricing, maxInputTokens: 100000 });
  await expect(provider.generateObject(request, z.object({ value: z.string() }))).rejects.toThrow(/commit failed/);
  expect(fake.requests).toHaveLength(1);
  for (const budgetId of ["global-month", "installation-month"]) {
    const ledger = await FirestoreSpendLedger.open({ ...cloud.options, budgetId });
    expect(await ledger.snapshot()).toMatchObject(phase === "before" ? { pendingAttempts: 1, reservedUsd: 0.1001, settledUsd: 0 } :
      { pendingAttempts: 0, reservedUsd: 0, settledUsd: usage.costUsd });
  }
});

it("fails closed when installation policy is absent or aliases the global allowance", async () => {
  const f = await fixture();
  await expect(FirestoreSpendLedger.open({ ...f.options, installationBudgetId: "missing-policy" })).rejects.toThrow(/absent/);
  await expect(FirestoreSpendLedger.open({ ...f.options, installationBudgetId: f.options.budgetId })).rejects.toThrow(/distinct/);
  await expect(FirestoreSpendLedger.initialize(f.scopedOptions, { maxUsd: 100, history: [] })).rejects.toThrow(/separately/);
  expect(f.records.size).toBe(2);
});

it("uses the authenticated installation for Hosted calls and denies absent monthly policy before the provider", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
  const cloud = createFakeFirestore("installationSpend");
  await FirestoreSpendLedger.initialize({ ...cloud.options, budgetId: "global-2026-10" }, { maxUsd: 1, history: [] });
  const installation = await FirestoreSpendLedger.initialize({ ...cloud.options, budgetId: "installation-42-2026-10" }, { maxUsd: 0.3, history: [] });
  const task = { id: "button-name:save", ruleId: "button-name", criterion: "4.1.2", kind: "semantic", route: "llm",
    source: { file: "components/Controls.tsx", line: 1, column: 1 }, routes: ["/"],
    violations: [{ ruleId: "button-name", impact: "serious", route: "/", target: ["#save"], html: "<button/>", failureSummary: "No name", condition: "desktop-light",
      source: { file: "components/Controls.tsx", line: 1, column: 1 } }] };
  const context = { component: { ...task.source, sourceExcerpt: '<button id="save" />' }, callSites: [],
    page: { title: "Settings", surroundingText: "Save changes", caption: null, linkTarget: null }, screenshotPath: null };
  const provider = new FakeLlmProvider([{ object: { taskId: task.id, changes: [{ path: task.source.file, before: '<button id="save" />', after: '<button id="save" aria-label="Save changes" />' }] }, usage }]);
  const agent = new HostedPatchAgent({ model, pricing, maxInputTokens: 100000, maxOutputTokens: 100,
    maxCostUsdPerRun: 0.2, provider, runStore: new InMemoryHostedAgentRunStore(),
    ledgerForRun: run => openMonthlyHostedSpend(cloud.options, run.installationId) });
  const token = await agent.registerRun({ runId: "authorized", repository: "owner/repo", installationId: 42 });
  expect((await agent.patch("authorized", token, task, context)).status).toBe("accepted");
  expect((await installation.snapshot()).settledAttempts).toBe(1);
  const other = await agent.registerRun({ runId: "unconfigured", repository: "owner/repo", installationId: 43 });
  await expect(agent.patch("unconfigured", other, task, context)).rejects.toThrow(/absent/);
  expect(provider.requests).toHaveLength(1);
});

it("requires explicitly initialized UTC monthly caps and preserves claims across rollover", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-31T23:59:59Z"));
  const cloud = createFakeFirestore("installationSpend");
  for (const budgetId of ["global-2026-10", "installation-42-2026-10"]) {
    await FirestoreSpendLedger.initialize({ ...cloud.options, budgetId }, { maxUsd: 1, history: [] });
  }
  const october = await openMonthlyHostedSpend(cloud.options, 42);
  const id = await october.reserve("fixture", 0.2, "a".repeat(64));
  vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
  await expect(openMonthlyHostedSpend(cloud.options, 42)).rejects.toThrow(/absent/);
  expect(cloud.records.size).toBe(3);
  for (const budgetId of ["global-2026-11", "installation-42-2026-11"]) {
    await FirestoreSpendLedger.initialize({ ...cloud.options, budgetId }, { maxUsd: 0.1, history: [] });
  }
  const november = await openMonthlyHostedSpend(cloud.options, 42);
  expect(await october.snapshot()).toMatchObject({ pendingAttempts: 1, reservedUsd: 0.2 });
  await expect(november.settle(id, usage)).rejects.toThrow(/Unknown budget/);
  await october.settle(id, usage);
  expect(await november.snapshot()).toMatchObject({ maxUsd: 0.1, pendingAttempts: 0, settledUsd: 0 });
});
