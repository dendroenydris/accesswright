import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { defaults } from "../../src/config.js";
import { FirestoreDispatchClaims } from "../../src/hosted/firestore-dispatch-claims.js";
import { FirestoreSpendLedger } from "../../src/hosted/firestore-spend-ledger.js";
import { readHostedExecution, runHostedExecutionCli } from "../../src/hosted/execution-read-entry.js";
import { runHostedSpendCli } from "../../src/hosted/spend-read-entry.js";
import { createFakeFirestore } from "../helpers/fake-firestore.js";

const run = { runId: "a".repeat(32), repository: "owner/private", installationId: 42, event: "installation" as const,
  pullNumber: null, createdAt: "2026-10-09T12:00:00.000Z" };
const job = "projects/accesswright-dev-123/locations/europe-west3/jobs/worker";
const operation = "projects/accesswright-dev-123/locations/europe-west3/operations/fixture", execution = job + "/executions/fixture";
function config(workRoot: string) {
  return { role: "agent", projectId: "accesswright-dev-123", region: "europe-west3", candidateBucket: "private-candidates",
    candidateQueueId: "candidates", candidateTaskOrigin: "https://candidate-owned.a.run.app", verifierOrigin: "https://verifier.owned.invalid",
    taskServiceAccountEmail: "tasks@accesswright-dev-123.iam.gserviceaccount.com", relayServiceAccountEmail: "relay@accesswright-dev-123.iam.gserviceaccount.com",
    workRoot, collections: { agentRuns: "runs", reports: "reports", checkoutPins: "pins", cleanup: "cleanup", spending: "spending", dispatch: "dispatch" },
    appId: 7, repositories: [run.repository], model: { provider: "openai", id: "fixture-only" }, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    maxInputTokens: 1200, maxOutputTokens: 256, maxCostUsdPerRun: 0.02, runtimeRoot: "/fixture/runtime",
    agentOrigin: "https://agent-owned.a.run.app", jobId: "worker", workerContainerName: "accesswright",
    jobTaskServiceAccountEmail: "jobs@accesswright-dev-123.iam.gserviceaccount.com" };
}

it.each(["missing", "claimed", "requires-reconciliation", "launched"])("reads only confirmed launched claims (%s), without modifying cloud records or using App/model keys", async status => {
  const root = await mkdtemp(join(tmpdir(), "aw-execution-read-")), store = createFakeFirestore("dispatch");
  const claims = new FirestoreDispatchClaims(store.options);
  if (status !== "missing") await claims.claim(run);
  if (status === "requires-reconciliation" || status === "launched") await claims.recordOutcome(run, status === "launched" ? operation : null);
  const before = JSON.stringify([...store.records]), calls: string[] = [];
  store.calls.length = 0;
  const fetcher: typeof fetch = (input, init) => {
    expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined(); expect(init?.redirect).toBe("error");
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); calls.push(url.href);
    if (url.origin === "http://metadata.google.internal") return Promise.resolve(Response.json({ access_token: "local-fixture-identity", expires_in: 3600, token_type: "Bearer" }, { headers: { "Metadata-Flavor": "Google" } }));
    if (url.origin === "https://firestore.googleapis.com") return store.fetcher(input, init);
    expect(url.origin).toBe("https://run.googleapis.com");
    if (url.pathname === "/v2/" + operation) return Promise.resolve(Response.json({ name: operation, done: true, response: { name: execution } }));
    expect(url.pathname).toBe("/v2/" + execution);
    return Promise.resolve(Response.json({ name: execution, job, taskCount: 1, startTime: "2026-10-09T12:01:00.000Z", completionTime: "2026-10-09T12:02:00.000Z",
      succeededCount: 1, conditions: [{ type: "Completed", state: "CONDITION_SUCCEEDED", message: "PRIVATE_SOURCE" }],
      template: { containers: [{ name: "accesswright", env: [{ name: "ACCESSWRIGHT_RUN_ID", value: run.runId },
        { name: "ACCESSWRIGHT_REPOSITORY", value: run.repository }, { name: "ACCESSWRIGHT_INSTALLATION_ID", value: "42" },
        { name: "ACCESSWRIGHT_PR_NUMBER" }, { name: "ACCESSWRIGHT_RUN_TOKEN", value: "PRIVATE_TOKEN" }] }] } }));
  };
  try {
    const result = await runHostedExecutionCli(["--run-id", run.runId], { ACCESSWRIGHT_HOSTED_CONFIG: JSON.stringify(config(root)) }, { fetcher });
    expect(result.status).toBe(status === "launched" ? "succeeded" : "unknown");
    expect(calls).toHaveLength(status === "launched" ? 4 : 2); expect(store.calls.map(call => call.method)).toEqual(["GET"]);
    expect(JSON.stringify([...store.records])).toBe(before);
    const trace = await readFile(join(root, "evidence", run.runId, "run.jsonl"), "utf8");
    expect(trace).toContain("hosted-execution-read-result"); expect(trace).toContain(result.status);
    expect(trace + JSON.stringify(result)).not.toMatch(/PRIVATE_|owner\/private|access_token|ACCESSWRIGHT_RUN_TOKEN/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("refuses invalid arguments, oversized config and the wrong role before any cloud access", async () => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.reject(new Error("No API access allowed")));
  await expect(runHostedExecutionCli(["--run-id", "../../private"], {}, { fetcher })).rejects.toThrow(/Expected/);
  await expect(runHostedExecutionCli(["--run-id", run.runId, "--retry"], {}, { fetcher })).rejects.toThrow(/Expected/);
  await expect(runHostedExecutionCli(["--run-id", run.runId], { ACCESSWRIGHT_HOSTED_CONFIG: " ".repeat(defaults.configMaxBytes + 1) }, { fetcher })).rejects.toThrow(/Bounded/);
  await expect(readHostedExecution({ ...config("/fixture"), role: "webhook" }, run.runId, { fetcher })).rejects.toThrow();
  await expect(readHostedExecution({ ...config("/fixture"), collections: { ...config("/fixture").collections, dispatch: "reports" } }, run.runId, { fetcher })).rejects.toThrow(/distinct/);
  expect(fetcher).not.toHaveBeenCalled();
});

it("records metadata-only access failure without acquiring a launch claim or writing cloud state", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-execution-denied-")), fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response("PRIVATE_DIAGNOSTIC", { status: 403 })));
  try {
    await expect(readHostedExecution(config(root), run.runId, { fetcher })).rejects.toThrow(/^Google workload access is unconfirmed$/);
    expect(fetcher).toHaveBeenCalledOnce();
    const trace = await readFile(join(root, "evidence", run.runId, "run.jsonl"), "utf8");
    expect(trace).toContain('"status":"error"'); expect(trace).not.toContain("PRIVATE_DIAGNOSTIC");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["pending", "unknown", "settled"])("reads original-month %s usage with only metadata GETs and no policy or accounting changes", async state => {
  const root = await mkdtemp(join(tmpdir(), "aw-usage-read-")), cloud = createFakeFirestore("spending");
  const options = { ...cloud.options, budgetId: "global-2026-09" };
  await FirestoreSpendLedger.initialize(options, { maxUsd: 1, history: [] });
  await FirestoreSpendLedger.initialize({ ...options, budgetId: "installation-42-2026-09" }, { maxUsd: 1, history: [] });
  const ledger = await FirestoreSpendLedger.open({ ...options, installationBudgetId: "installation-42-2026-09" });
  const id = await ledger.reserve("PRIVATE_MODEL", 0.1, "a".repeat(64));
  if (state === "unknown") await ledger.recordUnknown(id);
  if (state === "settled") await ledger.settle(id, { inputTokens: 1, outputTokens: 2, costUsd: 0.003 });
  const before = JSON.stringify([...cloud.records]), updateTime = new Date().toISOString(); cloud.calls.length = 0;
  const fetcher: typeof fetch = async (input, init) => {
    expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
    const uri = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (uri.origin === "http://metadata.google.internal") return Response.json({ access_token: "local-fixture-identity", expires_in: 3600, token_type: "Bearer" }, { headers: { "Metadata-Flavor": "Google" } });
    const response = await cloud.fetcher(input, init);
    if (response.status !== 200) return response;
    return Response.json({ ...await response.json() as Record<string, unknown>, updateTime });
  };
  const args = ["--reservation-id", id, "--installation-id", "42", "--month", "2026-09"], environment = { ACCESSWRIGHT_HOSTED_CONFIG: JSON.stringify(config(root)) };
  try {
    const result = await runHostedSpendCli(args, environment, { fetcher });
    expect(result).toEqual({ id, state, recordedAt: updateTime, costUsd: state === "settled" ? 0.003 : null });
    expect(cloud.calls.map(call => call.method)).toEqual(["GET", "GET", "GET"]);
    const trace = await readFile(join(root, "evidence", "usage", id, "run.jsonl"), "utf8");
    expect(trace + JSON.stringify(result)).not.toMatch(/PRIVATE_MODEL|promptHash|reservedUsd|historyUpperBound|budgetId/);
    await expect(runHostedSpendCli([...args.slice(0, 5), "2026-10"], environment, { fetcher })).rejects.toThrow(/absent/);
    expect(JSON.stringify([...cloud.records])).toBe(before);
    await expect(runHostedSpendCli([...args, "--retry"], environment, { fetcher })).rejects.toThrow(/Expected/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
