import { expect, it } from "vitest";
import { CloudRunJobInvoker } from "../../src/hosted/cloud-run-job.js";

const run = { runId: "a".repeat(32), repository: "owner/private", installationId: 42, event: "issue_comment" as const,
  pullNumber: 7, createdAt: "2026-10-09T12:00:00.000Z" };
const job = "projects/accesswright-dev-123/locations/europe-west3/jobs/worker";
const operation = "projects/accesswright-dev-123/locations/europe-west3/operations/fixture", execution = job + "/executions/fixture";
function fixture(override: Record<string, unknown> = {}, operationResult: Record<string, unknown> = { done: true, response: { name: execution } }) {
  const calls: string[] = [];
  const data = { name: execution, job, taskCount: 1, startTime: "2026-10-09T12:01:00.000Z", completionTime: "2026-10-09T12:02:00.000Z",
    succeededCount: 1, conditions: [{ type: "Completed", state: "CONDITION_SUCCEEDED", message: "PRIVATE_SOURCE_CANARY" }],
    template: { containers: [{ name: "accesswright", env: [
      { name: "ACCESSWRIGHT_RUN_ID", value: run.runId }, { name: "ACCESSWRIGHT_REPOSITORY", value: run.repository },
      { name: "ACCESSWRIGHT_INSTALLATION_ID", value: "42" }, { name: "ACCESSWRIGHT_PR_NUMBER", value: "7" },
      { name: "ACCESSWRIGHT_RUN_TOKEN", value: "PRIVATE_RUN_TOKEN_CANARY" },
    ] }] }, ...override };
  const invoker = new CloudRunJobInvoker({ projectId: "accesswright-dev-123", region: "europe-west3", jobId: "worker", containerName: "accesswright",
    getAccessToken: () => Promise.resolve("PRIVATE_ACCESS_CANARY"), fetcher: (input, init) => {
      expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("error"); expect(init?.body).toBeUndefined();
      const uri = typeof input === "string" ? input : input instanceof URL ? input.href : input.url; calls.push(uri);
      if (uri === "https://run.googleapis.com/v2/" + operation) return Promise.resolve(Response.json({ name: operation, ...operationResult }));
      expect(uri).toBe("https://run.googleapis.com/v2/" + execution); return Promise.resolve(Response.json(data));
    } });
  return { invoker, calls, data };
}

it.each(["succeeded", "failed", "running"])("reads a bound actual execution (%s) with only GETs and returns metadata", async status => {
  const override = status === "failed" ? { succeededCount: 0, failedCount: 1, conditions: [{ type: "Completed", state: "CONDITION_FAILED" }] } :
    status === "running" ? { completionTime: undefined, succeededCount: 0, runningCount: 1, conditions: [{ type: "Completed", state: "CONDITION_RECONCILING" }] } : {};
  const f = fixture(override), observed = await f.invoker.inspectExecution(run, operation);
  expect(observed).toMatchObject({ runId: run.runId, operation, execution, status, startedAt: "2026-10-09T12:01:00.000Z",
    finishedAt: status === "running" ? null : "2026-10-09T12:02:00.000Z" });
  expect(f.calls).toHaveLength(2); expect(JSON.stringify(observed)).not.toMatch(/PRIVATE_|owner\/private|ACCESSWRIGHT_RUN_TOKEN/);
});

it.each([{ done: false }, { done: true }, { done: true, response: {} }, { done: true, error: { code: 13, message: "PRIVATE_DIAGNOSTIC" } }])("keeps unresolved launch operations unknown without fetching or starting an execution (%j)", async result => {
  const f = fixture({}, result);
  expect(await f.invoker.inspectExecution(run, operation)).toMatchObject({ status: "unknown", execution: null, startedAt: null, finishedAt: null });
  expect(f.calls).toHaveLength(1);
});

it("rejects another job's operation response before making a request to that execution", async () => {
  const f = fixture({}, { done: true, response: { name: job.replace("/worker", "/other") + "/executions/fixture" } });
  await expect(f.invoker.inspectExecution(run, operation)).rejects.toThrow(/identity/); expect(f.calls).toHaveLength(1);
});

it.each(["name", "job", "run", "duplicate-marker", "duplicate-completed", "missing-marker", "duplicate-container", "secret-marker"])("refuses mismatched or duplicate execution identity (%s)", async fault => {
  const f = fixture();
  if (fault === "name") f.data.name = job + "/executions/other";
  if (fault === "job") f.data.job = job.replace("/worker", "/other");
  if (fault === "run") f.data.template.containers[0]?.env.splice(0, 1, { name: "ACCESSWRIGHT_RUN_ID", value: "b".repeat(32) });
  if (fault === "duplicate-marker") f.data.template.containers[0]?.env.push({ name: "ACCESSWRIGHT_RUN_ID", value: run.runId });
  if (fault === "duplicate-completed") f.data.conditions.push({ type: "Completed", state: "CONDITION_FAILED", message: "PRIVATE_SOURCE_CANARY" });
  if (fault === "missing-marker") f.data.template.containers[0]?.env.splice(1, 1);
  if (fault === "duplicate-container" && f.data.template.containers[0]) f.data.template.containers.push(f.data.template.containers[0]);
  if (fault === "secret-marker") Object.assign(f.data.template.containers[0]?.env[0] ?? {}, { valueSource: { secretKeyRef: { secret: "PRIVATE_REF" } } });
  await expect(f.invoker.inspectExecution(run, operation)).rejects.toThrow(/identity|condition/);
});

it.each([{ completionTime: undefined }, { reconciling: true }, { succeededCount: 0 }, { failedCount: 1 }, { startTime: undefined },
  { startTime: "2026-10-09T11:59:00.000Z" }, { completionTime: "2026-10-09T12:00:00.000Z" },
  { completionTime: "2099-10-09T12:02:00.000Z" }, { taskCount: 2 }, { runningCount: 1 }, { conditions: [] }])("withholds incomplete or inconsistent terminal evidence (%j)", async override => {
  expect(await fixture(override).invoker.inspectExecution(run, operation)).toMatchObject({ status: "unknown", finishedAt: null });
});

it("cancels oversized streamed execution evidence at the existing response bound", async () => {
  let cancelled = 0, pulls = 0;
  const invoker = new CloudRunJobInvoker({ projectId: "accesswright-dev-123", region: "europe-west3", jobId: "worker", containerName: "accesswright",
    getAccessToken: () => Promise.resolve("fixture"), fetcher: input => {
      if (input === "https://run.googleapis.com/v2/" + operation) return Promise.resolve(Response.json({ name: operation, done: true, response: { name: execution } }));
      const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(12001)); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
      return Promise.resolve(new Response(stream));
    } });
  await expect(invoker.inspectExecution(run, operation)).rejects.toThrow(/size limit/);
  expect(cancelled).toBe(1); expect(pulls).toBe(1);
});
