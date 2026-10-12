import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectHostedOperations, runHostedOperationCollectCli } from "../../src/hosted/operation-collect-entry.js";
import { evaluateOperationAlerts } from "../../src/hosted/operation-alerts.js";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-12T10:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); });
const run = { runId: "a".repeat(32), repository: "owner/private", installationId: 42, event: "installation",
  pullNumber: null, createdAt: "2026-10-10T12:00:00.000Z" };
const operation = "projects/accesswright-dev-123/locations/europe-west3/operations/fixture";
const job = "projects/accesswright-dev-123/locations/europe-west3/jobs/worker", execution = job + "/executions/fixture";
const id = "11111111-1111-4111-8111-111111111111";
function config(workRoot: string) {
  return { role: "agent", projectId: "accesswright-dev-123", region: "europe-west3", candidateBucket: "private-candidates",
    candidateQueueId: "candidates", candidateTaskOrigin: "https://candidate-owned.run.app", verifierOrigin: "https://verifier.owned.invalid",
    taskServiceAccountEmail: "tasks@accesswright-dev-123.iam.gserviceaccount.com", relayServiceAccountEmail: "relay@accesswright-dev-123.iam.gserviceaccount.com",
    workRoot, collections: { agentRuns: "runs", reports: "reports", checkoutPins: "pins", cleanup: "cleanup", spending: "spending", dispatch: "dispatch" },
    appId: 7, repositories: [run.repository], model: { provider: "openai", id: "fixture-only" }, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    maxInputTokens: 1200, maxOutputTokens: 256, maxCostUsdPerRun: 0.02, runtimeRoot: "/fixture/runtime",
    agentOrigin: "https://agent-owned.run.app", jobId: "worker", workerContainerName: "accesswright",
    jobTaskServiceAccountEmail: "jobs@accesswright-dev-123.iam.gserviceaccount.com" };
}
const policy = { failureRate: 0.1, dailyCostUsd: 0.2, p95DurationMs: 60000, minimumCompletedJobs: 1 };

async function fixture() {
  vi.setSystemTime(new Date("2026-10-12T10:00:00.000Z"));
  const root = await mkdtemp(join(tmpdir(), "aw-operation-collection-"));
  const budget = (runId: string, settledAttempts: number, settledUsd: number) => ({ runId, kind: "budget", currency: "USD", maxUsd: 1,
    historyDigest: "b".repeat(64), historyUpperBoundUsd: 0, settledUsd, reservedUsd: 0, blocked: false,
    pendingAttempts: 0, unknownAttempts: 0, settledAttempts });
  const rows: Record<string, unknown>[] = [budget("global-2026-09", 1, 0.25), budget("installation-42-2026-09", 1, 0.25), budget("global-2026-10", 0, 0),
    { runId: id, kind: "reservation", budgetId: "global-2026-09", installationBudgetId: "installation-42-2026-09",
      model: "PRIVATE_MODEL", promptHash: "c".repeat(64), createdAt: "2026-09-30T12:00:00.000Z", reservedUsd: 0.5,
      state: "settled", usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.25 } }];
  const claims = [{ ...run, status: "launched", operation }];
  const calls: URL[] = [];
  let version = "2026-10-11T05:00:00.000Z", pageFailure = false, executionFailure = false, operationDone = true;
  const actual = { name: execution, job, taskCount: 1, startTime: "2026-10-10T13:00:00.000Z", completionTime: "2026-10-11T03:00:00.000Z",
    succeededCount: 1, conditions: [{ type: "Completed", state: "CONDITION_SUCCEEDED", message: "PRIVATE_SOURCE" }],
    template: { containers: [{ name: "accesswright", env: [{ name: "ACCESSWRIGHT_RUN_ID", value: run.runId },
      { name: "ACCESSWRIGHT_REPOSITORY", value: run.repository }, { name: "ACCESSWRIGHT_INSTALLATION_ID", value: "42" },
      { name: "ACCESSWRIGHT_PR_NUMBER" }, { name: "ACCESSWRIGHT_RUN_TOKEN", value: "PRIVATE_TOKEN" }] }] } };
  const directory: Record<string, unknown>[] = [{ name: execution, job, createTime: run.createdAt }];
  let directoryDenied = false;
  const fetcher: typeof fetch = (input, init) => {
    const uri = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); calls.push(uri);
    expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined(); expect(init?.redirect).toBe("error");
    if (uri.origin === "http://metadata.google.internal") return Promise.resolve(Response.json({ access_token: "fixture-identity", expires_in: 3600,
      token_type: "Bearer" }, { headers: { "Metadata-Flavor": "Google" } }));
    if (uri.origin === "https://firestore.googleapis.com") {
      expect(uri.searchParams.get("readTime")).toBe("2026-10-12T10:00:00.000Z");
      const offset = Number(uri.searchParams.get("pageToken") ?? 0), entries = uri.pathname.endsWith("/dispatch") ? claims : rows;
      if (pageFailure && offset > 0) return Promise.resolve(new Response("PRIVATE_ERROR", { status: 403 }));
      vi.setSystemTime(new Date("2026-10-12T10:01:00.000Z"));
      return Promise.resolve(Response.json({ documents: entries.slice(offset, offset + 1).map(entry => ({ updateTime: uri.pathname.endsWith("/dispatch") ? "2026-10-12T09:00:00.000Z" : version,
        fields: { payload: { stringValue: JSON.stringify(entry) } } })), ...(offset + 1 < entries.length ? { nextPageToken: String(offset + 1) } : {}) }));
    }
    expect(uri.origin).toBe("https://run.googleapis.com");
    if (uri.pathname === "/v2/" + job + "/executions") return Promise.resolve(directoryDenied ? new Response("PRIVATE_ERROR", { status: 403 }) : Response.json({ executions: directory }));
    if (executionFailure) return Promise.resolve(new Response("PRIVATE_ERROR", { status: 403 }));
    if (uri.pathname === "/v2/" + operation) return Promise.resolve(Response.json({ name: operation, done: operationDone,
      ...(operationDone ? { response: { name: execution } } : {}) }));
    expect(uri.pathname).toBe("/v2/" + execution); return Promise.resolve(Response.json(actual));
  };
  return { root, rows, claims, calls, actual, directory, fetcher, config: config(root), failDirectory: () => { directoryDenied = true; },
    setVersion: (value: string) => { version = value; }, failPage: () => { pageFailure = true; },
    failExecution: () => { executionFailure = true; }, pendingOperation: () => { operationDone = false; },
    collect: () => collectHostedOperations(config(root), "2026-10-11", { fetcher }),
    close: () => rm(root, { recursive: true, force: true }) };
}

it("collects a closed day from one pinned metadata snapshot and fresh actual execution, preserving original month and server settlement time", async () => {
  const f = await fixture(), before = JSON.stringify([f.rows, f.claims]);
  try {
    const result = await runHostedOperationCollectCli(["--day", "2026-10-11"], { ACCESSWRIGHT_HOSTED_CONFIG: JSON.stringify(f.config) }, { fetcher: f.fetcher });
    expect(result.snapshot.jobs).toEqual([{ runId: run.runId, status: "succeeded", startedAt: f.actual.startTime, finishedAt: f.actual.completionTime }]);
    expect(result.snapshot.calls).toEqual([{ id, recordedAt: "2026-10-11T05:00:00.000Z", state: "settled", costUsd: 0.25 }]);
    expect(result.snapshot.complete).toEqual({ jobs: false, calls: true });
    expect(result.coverage).toMatchObject({ readTime: "2026-10-12T10:00:00.000Z", claims: 1, reservations: 1, unresolvedJobs: 0, accountingConsistent: true, jobInventory: "unverified-retention" });
    expect(evaluateOperationAlerts(result.snapshot, policy).alerts).toEqual({ dailyCostUsd: "breached", failureRate: "insufficient-data", p95DurationMs: "insufficient-data" });
    expect(JSON.stringify([f.rows, f.claims])).toBe(before);
    const trace = await readFile(join(f.root, "evidence", "operations", "2026-10-11", "run.jsonl"), "utf8");
    expect(trace).toContain("hosted-operations-execution-read"); expect(trace).toContain("hosted-operations-collect-result");
    expect(JSON.stringify(result) + trace).not.toMatch(/PRIVATE_|owner\/private|promptHash|reservedUsd|budgetId|access_token|ACCESSWRIGHT_RUN_TOKEN/);
  } finally { await f.close(); }
});

it.each(["pending", "unknown"])("retains %s carryover uncertainty even when its server version is before the selected day", async state => {
  const f = await fixture();
  for (const budget of f.rows.slice(0, 2)) Object.assign(budget, { settledAttempts: 0, settledUsd: 0, reservedUsd: 0.5,
    pendingAttempts: state === "pending" ? 1 : 0, unknownAttempts: state === "unknown" ? 1 : 0 });
  Object.assign(f.rows[3], { state }); delete f.rows[3].usage; f.setVersion("2026-09-30T13:00:00.000Z");
  try {
    const result = await f.collect(); expect(result.snapshot.calls).toEqual([]);
    expect(result.coverage).toMatchObject({ accountingConsistent: true, unsettledBeforeClose: 1 }); expect(result.snapshot.complete.calls).toBe(false);
    expect(evaluateOperationAlerts(result.snapshot, { ...policy, dailyCostUsd: 1 }).alerts.dailyCostUsd).toBe("insufficient-data");
  } finally { await f.close(); }
});

it.each(["missing-row", "missing-original-policy", "missing-selected-policy", "wrong-scope", "wrong-count", "wrong-cost", "history"])("withholds healthy costs for %s without resetting policy or discarding known spend", async defect => {
  const f = await fixture();
  if (defect === "missing-row") f.rows.splice(3, 1);
  if (defect === "missing-original-policy") f.rows.splice(1, 1);
  if (defect === "missing-selected-policy") f.rows.splice(2, 1);
  if (defect === "wrong-scope") f.rows[3].installationBudgetId = "installation-42-2026-10";
  if (defect === "wrong-count") f.rows[0].settledAttempts = 2;
  if (defect === "wrong-cost") f.rows[1].settledUsd = 0.3;
  if (defect === "history") f.rows[0].historyUpperBoundUsd = 0.2;
  try {
    const result = await f.collect(); expect(result.snapshot.complete.calls).toBe(false);
    expect(evaluateOperationAlerts(result.snapshot, { ...policy, dailyCostUsd: 1 }).alerts.dailyCostUsd).toBe("insufficient-data");
    if (defect !== "missing-row") expect(evaluateOperationAlerts(result.snapshot, policy).alerts.dailyCostUsd).toBe("breached");
  } finally { await f.close(); }
});

it.each(["claimed", "requires-reconciliation", "operation-pending", "denied-execution", "marker-mismatch"])("does not invent a job start or terminal outcome for %s", async state => {
  const f = await fixture();
  if (state === "claimed" || state === "requires-reconciliation") Object.assign(f.claims[0], { status: state, operation: null });
  if (state === "operation-pending") f.pendingOperation();
  if (state === "denied-execution") f.failExecution();
  if (state === "marker-mismatch") f.actual.template.containers[0].env[0].value = "b".repeat(32);
  try {
    const result = await f.collect(); expect(result.snapshot.jobs).toEqual([]);
    expect(result.coverage.unresolvedJobs).toBe(1); expect(result.snapshot.complete.jobs).toBe(false);
    expect(result.snapshot.calls[0].costUsd).toBe(0.25);
  } finally { await f.close(); }
});

it("places settled calls and completed jobs by their actual terminal day, never the reservation or dispatch creation day", async () => {
  const f = await fixture(); f.setVersion("2026-10-12T05:00:00.000Z"); f.actual.completionTime = "2026-10-12T03:00:00.000Z";
  try {
    const result = await f.collect(); expect(result.snapshot.calls).toEqual([]); expect(result.snapshot.jobs).toEqual([]);
    expect(result.coverage.excludedJobs).toBe(1); expect(result.snapshot.complete.calls).toBe(true);
  } finally { await f.close(); }
});

it.each(["running", "unknown", "failed"])("keeps confirmed %s execution evidence without promoting it to complete fleet coverage", async state => {
  const f = await fixture();
  if (state === "failed") Object.assign(f.actual, { succeededCount: 0, failedCount: 1, conditions: [{ type: "Completed", state: "CONDITION_FAILED", message: "PRIVATE_SOURCE" }] });
  else {
    Object.assign(f.actual, { succeededCount: 0, runningCount: state === "running" ? 1 : 0,
      conditions: [{ type: "Completed", state: "CONDITION_PENDING", message: "PRIVATE_SOURCE" }] });
    Reflect.deleteProperty(f.actual, "completionTime");
  }
  try {
    const result = await f.collect(); expect(result.snapshot.jobs[0].status).toBe(state);
    expect(result.snapshot.jobs[0].finishedAt).toBe(state === "failed" ? "2026-10-11T03:00:00.000Z" : null);
    expect(result.snapshot.complete.jobs).toBe(false);
  } finally { await f.close(); }
});

it("does not inspect claims created after the selected day or count their start as that day's running job", async () => {
  const f = await fixture(); f.claims[0].createdAt = "2026-10-12T01:00:00.000Z";
  try {
    const result = await f.collect(); expect(result.snapshot.jobs).toEqual([]); expect(result.coverage.excludedJobs).toBe(1);
    expect(f.calls.filter(url => url.origin === "https://run.googleapis.com").map(url => url.pathname)).toEqual(["/v2/" + job + "/executions"]);
  } finally { await f.close(); }
});

it("reports the actual resource directory and unmatched/deleted identities without turning list completion into healthy coverage", async () => {
  const f = await fixture();
  f.directory.push({ name: job + "/executions/unmatched", job, createTime: "2026-10-11T01:00:00.000Z",
    completionTime: "2026-10-11T02:00:00.000Z", deleteTime: "2026-10-11T03:00:00.000Z", expireTime: "2099-10-11T03:00:00.000Z" });
  try {
    const result = await f.collect();
    expect(result.coverage.executionInventory).toMatchObject({ listed: 2, unmatchedExecutionIds: [job + "/executions/unmatched"], missingExecutionIds: [] });
    expect(result.snapshot.jobs).toHaveLength(1); expect(result.snapshot.complete.jobs).toBe(false);
    expect(await readFile(join(f.root, "evidence", "operations", "2026-10-11", "run.jsonl"), "utf8")).toContain("hosted-operations-inventory-read");
  } finally { await f.close(); }
});

it("reports confirmed executions missing from the later resource directory, rather than silently treating an empty directory as complete", async () => {
  const f = await fixture(); f.directory.length = 0;
  try {
    const result = await f.collect(); expect(result.coverage.executionInventory).toMatchObject({ listed: 0, missingExecutionIds: [execution], unmatchedExecutionIds: [] });
    expect(result.snapshot.jobs[0].status).toBe("succeeded"); expect(result.snapshot.complete.jobs).toBe(false);
  } finally { await f.close(); }
});

it.each(["denied", "invalid", "duplicate"])("preserves confirmed jobs/costs but leaves directory counts null after %s inventory", async fault => {
  const f = await fixture();
  if (fault === "denied") f.failDirectory();
  if (fault === "invalid") f.directory[0].job = "projects/other-project/locations/europe-west3/jobs/worker";
  if (fault === "duplicate") f.directory.push({ ...f.directory[0] });
  try {
    const result = await f.collect(); expect(result.coverage.executionInventory).toEqual({ observedAt: null, listed: null, missingExecutionIds: null, unmatchedExecutionIds: null });
    expect(result.snapshot.jobs[0].status).toBe("succeeded"); expect(result.snapshot.calls[0].costUsd).toBe(0.25); expect(result.snapshot.complete.jobs).toBe(false);
  } finally { await f.close(); }
});

it("excludes directory resources belonging to other days but retains untimed resources as unmatched", async () => {
  const f = await fixture();
  f.directory.push({ name: job + "/executions/next-day", job, createTime: "2026-10-12T01:00:00.000Z" },
    { name: job + "/executions/previous-day", job, createTime: "2026-10-09T01:00:00.000Z", completionTime: "2026-10-10T01:00:00.000Z" },
    { name: job + "/executions/not-started", job, createTime: "2026-10-11T01:00:00.000Z" });
  try {
    const result = await f.collect(); expect(result.coverage.executionInventory.unmatchedExecutionIds).toEqual([job + "/executions/not-started"]);
    expect(result.snapshot.jobs).toHaveLength(1);
  } finally { await f.close(); }
});

it.each(["2026-09-30T11:00:00.000Z", "2026-10-12T11:00:00.000Z"])("refuses impossible snapshot versions (%s) without substituting creation time", async version => {
  const f = await fixture(); f.setVersion(version);
  try { await expect(f.collect()).rejects.toThrow(/timestamp|version/); } finally { await f.close(); }
});

it("refuses partial pagination, duplicate operation identities and worker fields instead of emitting a complete export", async () => {
  const f = await fixture(); f.failPage();
  try { await expect(f.collect()).rejects.toThrow(/list failed/); } finally { await f.close(); }
  const duplicate = await fixture(); duplicate.claims.push({ ...duplicate.claims[0], runId: "b".repeat(32) });
  try { await expect(duplicate.collect()).rejects.toThrow(/Repeated execution/); } finally { await duplicate.close(); }
  const extra = await fixture(); Object.assign(extra.claims[0], { workerSucceeded: true });
  try { await expect(extra.collect()).rejects.toThrow(); } finally { await extra.close(); }
});

it("refuses open/invalid days, extra flags and non-agent configuration before any cloud access", async () => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.reject(new Error("No cloud access")));
  for (const day of ["2026-10-12", "2026-02-30", "../private"]) await expect(collectHostedOperations(config("/fixture"), day, { fetcher })).rejects.toThrow(/closed UTC day/);
  await expect(runHostedOperationCollectCli(["--day", "2026-10-11", "--complete"], {}, { fetcher })).rejects.toThrow(/Expected/);
  await expect(collectHostedOperations({ ...config("/fixture"), role: "relay" }, "2026-10-11", { fetcher })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
