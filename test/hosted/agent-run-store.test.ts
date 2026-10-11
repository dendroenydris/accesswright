import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaults } from "../../src/config.js";

import { HostedPatchAgent } from "../../src/hosted/agent-api.js";
import { FirestoreHostedAgentRunStore } from "../../src/hosted/agent-run-store.js";
import { HostedRunWorkflow, InMemoryHostedRunStore } from "../../src/hosted/run-workflow.js";
import { DurableSpendLedger } from "../../src/llm/durable-spend.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";
import { createFakeFirestore } from "../helpers/fake-firestore.js";

const roots: string[] = [];
const task = {
  id: "button-name:save", ruleId: "button-name", criterion: "4.1.2", kind: "semantic", route: "llm",
  source: { file: "components/Controls.tsx", line: 4, column: 7 }, routes: ["/"],
  violations: [{ ruleId: "button-name", impact: "serious", route: "/", target: ["#save"],
    html: '<button id="save"></button>', failureSummary: "No name", condition: "desktop-light",
    source: { file: "components/Controls.tsx", line: 4, column: 7 } }],
};
const context = {
  component: { file: "components/Controls.tsx", line: 4, column: 7, sourceExcerpt: '<button id="save"></button>' },
  callSites: [], page: { title: "Settings", surroundingText: "Save changes", caption: null, linkTarget: null },
  screenshotPath: null,
};
async function fixture(maxCostUsdPerRun = 0.02, maxTaskTokens: number = defaults.maxTaskTokens) {
  const root = await mkdtemp(join(tmpdir(), "aw-durable-auth-"));
  roots.push(root);
  const ledger = await DurableSpendLedger.initialize(join(root, "spend.json"), { maxUsd: 1, history: [] });
  const cloud = createFakeFirestore("accesswrightAuthorizations", 1);
  const provider = new FakeLlmProvider(Array.from({ length: 3 }, () => ({
    object: { taskId: task.id, changes: [{ path: "components/Controls.tsx", before: '<button id="save"></button>', after: '<button id="save" aria-label="Save changes"></button>' }] },
    usage: { inputTokens: 300, outputTokens: 100, costUsd: 0.0005 },
  })));
  const options = {
    model: { provider: "openai" as const, id: "fixture-only", reasoningEffort: "high" as const },
    pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, maxInputTokens: 1000,
    maxOutputTokens: 256, maxCostUsdPerRun, maxTaskTokens, ledgerForRun: () => Promise.resolve(ledger), provider, providerVerification: "fake-provider" as const,
  };
  const openStore = () => new FirestoreHostedAgentRunStore(cloud.options);
  const open = () => new HostedPatchAgent({ ...options, runStore: openStore() });
  return { cloud, options, provider, ledger, open, openStore };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("recovers token authentication and consumed request limits across service restarts without storing private context", async () => {
  const f = await fixture(), first = f.open();
  const token = await first.registerRun({ runId: "run-1", repository: "owner/private-app", installationId: 42, maxRequests: 1 });
  expect((await first.patch("run-1", token, task, context)).status).toBe("accepted");
  const restarted = f.open();
  expect(await restarted.inspectRun("run-1", token)).toMatchObject({ requestCount: 1, settledRequests: 1, inputTokens: 300, outputTokens: 100, spentUsd: 0.0005, lastStatus: "accepted" });
  await expect(restarted.patch("run-1", token, task, context)).rejects.toThrow(/limit/i);
  await expect(restarted.registerRun({ runId: "run-1", repository: "owner/private-app", installationId: 42 })).rejects.toThrow(/exists|conflict/i);
  expect(f.provider.requests).toHaveLength(1);
  const persisted = JSON.stringify([...f.cloud.records.values()]);
  expect(persisted).not.toContain(token);
  expect(persisted).not.toContain("Save changes");
  expect(persisted).not.toContain("local-fixture-identity");
  expect(JSON.stringify(await restarted.records())).not.toContain("tokenHash");
  const workflow = new HostedRunWorkflow({ store: new InMemoryHostedRunStore(),
    authenticate: (id, authorization) => restarted.inspectRun(id, authorization),
    verifyTrustedResult: () => Promise.resolve(null) });
  expect(await workflow.inspect("run-1", token)).toBeUndefined();
  await expect(workflow.inspect("run-1", "0".repeat(64))).rejects.toThrow(/authorization/i);
});

it("claims a provider request once across two independent service replicas", async () => {
  const f = await fixture(), a = f.open(), b = f.open();
  const token = await a.registerRun({ runId: "run-2", repository: "owner/repo", installationId: 42 });
  const results = await Promise.allSettled([a.patch("run-2", token, task, context), b.patch("run-2", token, task, context)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  expect(f.provider.requests).toHaveLength(1);
  expect(await f.open().inspectRun("run-2", token)).toMatchObject({ requestCount: 1, spentUsd: 0.0005 });
});

it("consumes private input once across replicas and retains the claim after restart", async () => {
  const f = await fixture(), first = f.open();
  const token = await first.registerRun({ runId: "run-input", repository: "owner/repo", installationId: 42 });
  await expect(first.claimInput("run-input", "0".repeat(64))).rejects.toThrow(/authorization/);
  const results = await Promise.allSettled([first.claimInput("run-input", token), f.open().claimInput("run-input", token)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  await expect(f.open().claimInput("run-input", token)).rejects.toThrow(/claimed/);
  await expect(f.openStore().update("run-input", run => ({ ...run, inputClaimed: false }))).rejects.toThrow(/authorization/);
  expect(f.provider.requests).toHaveLength(0);
  const persisted = JSON.stringify([...f.cloud.records.values()]);
  expect(persisted).not.toContain(token); expect(persisted).not.toContain("private fixture marker");
});

it("does not release source after sealing or after a provider request has started", async () => {
  const f = await fixture(), first = f.open();
  const token = await first.registerRun({ runId: "run-input-sealed", repository: "owner/repo", installationId: 42 });
  await first.sealForVerification("run-input-sealed");
  await expect(f.open().claimInput("run-input-sealed", token)).rejects.toThrow(/closed/);
  const called = await first.registerRun({ runId: "run-input-called", repository: "owner/repo", installationId: 42 });
  await first.patch("run-input-called", called, task, context);
  await expect(f.open().claimInput("run-input-called", called)).rejects.toThrow(/closed/);
});

it("preserves cumulative per-task token caps across restarts, larger operator limits and changed task IDs", async () => {
  const f = await fixture(0.1, 12000);
  f.options.maxInputTokens = 20000;
  const provider = new FakeLlmProvider([{ object: { taskId: task.id, changes: [{ path: context.component.file, before: context.component.sourceExcerpt, after: '<button id="save" aria-label="Save"></button>' }] },
    usage: { inputTokens: 8000, outputTokens: 100, costUsd: 0.0082 } }]);
  const first = new HostedPatchAgent({ ...f.options, provider, runStore: f.openStore() });
  const token = await first.registerRun({ runId: "run-task-cap", repository: "owner/repo", installationId: 42 });
  expect((await first.patch("run-task-cap", token, task, context)).status).toBe("accepted");
  const restarted = new HostedPatchAgent({ ...f.options, maxTaskTokens: 100000, provider, runStore: f.openStore() });
  await expect(restarted.patch("run-task-cap", token, { ...task, id: "changed-worker-task-id" }, context)).rejects.toThrow(/token limit/);
  expect(provider.requests).toHaveLength(1);
  const stored = await f.openStore().get("run-task-cap");
  expect(stored?.record).toMatchObject({ inputTokens: 8000, outputTokens: 100, maxTaskTokens: 12000 });
  const text = JSON.stringify(stored);
  expect(text).not.toContain(task.id);
  expect(text).not.toContain(context.component.file);
  await expect(f.openStore().update("run-task-cap", run => ({ ...run, taskTokens: {} }))).rejects.toThrow(/usage/);
  await expect(f.openStore().update("run-task-cap", run => ({ ...run, record: { ...run.record, maxTaskTokens: 100000 } }))).rejects.toThrow(/authorization/);
});

it("rejects an actual token-cap overshoot while retaining its known service usage", async () => {
  const f = await fixture(0.1, 18000);
  f.options.maxInputTokens = 20000;
  const provider = new FakeLlmProvider([{ object: { taskId: task.id, changes: [{ path: context.component.file, before: context.component.sourceExcerpt, after: '<button id="save" aria-label="Save"></button>' }] },
    usage: { inputTokens: 18000, outputTokens: 100, costUsd: 0.0182 } }]);
  const service = new HostedPatchAgent({ ...f.options, provider, runStore: f.openStore() });
  const token = await service.registerRun({ runId: "run-task-overshoot", repository: "owner/repo", installationId: 42 });
  const response = await service.patch("run-task-overshoot", token, task, context);
  expect(response).toMatchObject({ status: "rejected", usage: { inputTokens: 18000 } });
  expect(response.status === "rejected" ? response.reason : "").toMatch(/token/);
  await expect(service.patch("run-task-overshoot", token, task, context)).rejects.toThrow(/token limit/);
  expect(await service.sealForVerification("run-task-overshoot")).toEqual({ usage: { inputTokens: 18000, outputTokens: 100, spentUsd: 0.0182 }, unknownUsage: false, providerVerification: "fake-provider" });
  expect(provider.requests).toHaveLength(1);
});

it("seals cumulative service usage across restarts before independent verification", async () => {
  const f = await fixture(), first = f.open();
  const token = await first.registerRun({ runId: "run-sealed", repository: "owner/repo", installationId: 42 });
  await first.patch("run-sealed", token, task, context);
  await f.open().patch("run-sealed", token, task, context);
  const expected = { usage: { inputTokens: 600, outputTokens: 200, spentUsd: 0.001 }, unknownUsage: false, providerVerification: "fake-provider" };
  expect(await f.open().sealForVerification("run-sealed")).toEqual(expected);
  expect(await f.open().sealForVerification("run-sealed")).toEqual(expected);
  await expect(f.open().patch("run-sealed", token, task, context)).rejects.toThrow(/sealed/);
  await expect(f.openStore().update("run-sealed", run => ({ ...run, sealed: false }))).rejects.toThrow(/authorization/);
  for (const field of ["inputTokens", "outputTokens", "settledRequests"] as const) {
    await expect(f.openStore().update("run-sealed", run => ({ ...run, record: { ...run.record, [field]: 0 } }))).rejects.toThrow(/usage/);
  }
  expect(f.provider.requests).toHaveLength(2);
});

it("keeps no-call and rejected-call usage distinct and prevents fake evidence becoming provider API evidence", async () => {
  const f = await fixture(), first = f.open();
  await first.registerRun({ runId: "run-empty", repository: "owner/repo", installationId: 42 });
  expect(await f.open().sealForVerification("run-empty")).toEqual({ usage: { inputTokens: 0, outputTokens: 0, spentUsd: 0 }, unknownUsage: false, providerVerification: "not-run" });
  const provider = new FakeLlmProvider([{ object: { taskId: "wrong-task", changes: [] }, usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.00012 } }]);
  const rejected = new HostedPatchAgent({ ...f.options, provider, runStore: f.openStore() });
  const token = await rejected.registerRun({ runId: "run-rejected", repository: "owner/repo", installationId: 42 });
  expect((await rejected.patch("run-rejected", token, task, context)).status).toBe("rejected");
  expect(await f.open().sealForVerification("run-rejected")).toEqual({ usage: { inputTokens: 100, outputTokens: 10, spentUsd: 0.00012 }, unknownUsage: false, providerVerification: "fake-provider" });
  const changed = new HostedPatchAgent({ ...f.options, providerVerification: "provider-api", runStore: f.openStore() });
  await expect(changed.sealForVerification("run-rejected")).rejects.toThrow(/model authorization/);
});

it("preserves equivalent model configurations and ignores later caller mutations", async () => {
  const f = await fixture(), first = f.open();
  const token = await first.registerRun({ runId: "run-model", repository: "owner/repo", installationId: 42 });
  const restarted = new HostedPatchAgent({ ...f.options,
    model: { id: "fixture-only", reasoningEffort: "high", provider: "openai" }, runStore: f.openStore() });
  f.options.model.id = "caller-mutated-model";
  f.options.pricing.inputUsdPerMillion = 1000;
  expect((await restarted.patch("run-model", token, task, context)).status).toBe("accepted");
  expect(f.provider.requests[0]?.model.id).toBe("fixture-only");
  expect(await first.inspectRun("run-model", token)).toMatchObject({ spentUsd: 0.0005 });
});

it("keeps the original per-run cost ceiling when a restarted service has a larger allowance", async () => {
  const f = await fixture(0.002), first = f.open();
  const token = await first.registerRun({ runId: "run-3", repository: "owner/repo", installationId: 42 });
  await first.patch("run-3", token, task, context);
  const restarted = new HostedPatchAgent({ ...f.options, maxCostUsdPerRun: 1, runStore: f.openStore() });
  await expect(restarted.patch("run-3", token, task, context)).rejects.toThrow(/limit/i);
  expect(f.provider.requests).toHaveLength(1);
  await expect(f.openStore().update("run-3", run => ({ ...run, record: { ...run.record, maxCostUsd: 1 } }))).rejects.toThrow(/authorization/i);
});

it("blocks an interrupted in-flight request and model substitution after restart", async () => {
  const f = await fixture(), first = f.open();
  const token = await first.registerRun({ runId: "run-4", repository: "owner/repo", installationId: 42 });
  await f.openStore().update("run-4", run => ({ ...run, inFlight: true, record: { ...run.record, requestCount: 1 } }));
  await expect(f.open().sealForVerification("run-4")).rejects.toThrow(/in flight/);
  await expect(f.open().patch("run-4", token, task, context)).rejects.toThrow(/in flight/i);
  const changed = new HostedPatchAgent({ ...f.options, model: { ...f.options.model, id: "substitute" }, runStore: f.openStore() });
  await expect(changed.patch("run-4", token, task, context)).rejects.toThrow(/model authorization/i);
  expect(f.provider.requests).toHaveLength(0);
});

it("retains unknown provider usage across restarts instead of retrying it as a free call", async () => {
  const f = await fixture();
  const provider = new FakeLlmProvider([{ error: new Error("fixture interrupted provider") }]);
  const first = new HostedPatchAgent({ ...f.options, provider, runStore: f.openStore() });
  const token = await first.registerRun({ runId: "run-5", repository: "owner/repo", installationId: 42 });
  expect(await first.patch("run-5", token, task, context)).toMatchObject({ status: "rejected", usage: null });
  expect(await f.open().inspectRun("run-5", token)).toMatchObject({ usageUnknown: true, lastStatus: "blocked", requestCount: 1 });
  await expect(f.open().patch("run-5", token, task, context)).rejects.toThrow(/unknown usage/i);
  expect(await f.open().sealForVerification("run-5")).toMatchObject({ unknownUsage: true, providerVerification: "not-run" });
  await expect(f.open().patch("run-5", token, task, context)).rejects.toThrow(/sealed/i);
  expect(f.provider.requests).toHaveLength(0);
  expect((await f.ledger.snapshot()).unknownAttempts).toBe(1);
});

it("keeps a consumed request blocked when storage fails after the provider responds", async () => {
  const f = await fixture();
  let writes = 0;
  const runStore = new FirestoreHostedAgentRunStore({ ...f.cloud.options,
    fetcher: (input, init) => init?.method === "PATCH" && ++writes > 1
      ? Promise.resolve(new Response("private-error-body", { status: 503 })) : f.cloud.fetcher(input, init),
  });
  const service = new HostedPatchAgent({ ...f.options, runStore });
  const token = await service.registerRun({ runId: "run-storage", repository: "owner/repo", installationId: 42 });
  await expect(service.patch("run-storage", token, task, context)).rejects.toThrow("Firestore metadata update failed (HTTP 503)");
  expect(await f.open().inspectRun("run-storage", token)).toMatchObject({ requestCount: 1 });
  await expect(f.open().patch("run-storage", token, task, context)).rejects.toThrow(/in flight/i);
  expect(f.provider.requests).toHaveLength(1);
  expect((await f.ledger.snapshot()).settledUsd).toBe(0.0005);
});

it("rejects expired tokens and schema-invalid persisted records, and lists all metadata pages", async () => {
  const f = await fixture(), service = f.open();
  const token = await service.registerRun({ runId: "run-6", repository: "owner/repo", installationId: 42, expiresInSeconds: 30 });
  await service.registerRun({ runId: "run-7", repository: "owner/repo", installationId: 42 });
  expect(await f.open().records()).toHaveLength(2);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
  await expect(f.open().inspectRun("run-6", token)).rejects.toThrow(/expired/i);
  vi.restoreAllMocks();
  const current = f.cloud.records.get("run-6");
  if (!current) throw new Error("Missing fixture record");
  const payload: unknown = JSON.parse(current.payload);
  if (typeof payload !== "object" || payload === null) throw new Error("Invalid fixture record");
  current.payload = JSON.stringify({ ...payload, privateSource: "must-not-store-source" });
  await expect(f.open().inspectRun("run-6", token)).rejects.toThrow();
  expect(f.provider.requests).toHaveLength(0);
});
