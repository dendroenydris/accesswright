import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

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
async function fixture(maxCostUsdPerRun = 0.02) {
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
    maxOutputTokens: 256, maxCostUsdPerRun, ledger, provider,
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
  expect(await restarted.inspectRun("run-1", token)).toMatchObject({ requestCount: 1, spentUsd: 0.0005, lastStatus: "accepted" });
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
