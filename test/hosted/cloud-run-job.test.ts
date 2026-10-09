import { expect, it } from "vitest";

import { CloudRunJobInvoker } from "../../src/hosted/cloud-run-job.js";
import type { QueuedRun } from "../../src/hosted/webhook.js";

const run: QueuedRun = {
  runId: "a".repeat(32), repository: "owner/private", installationId: 42,
  event: "issue_comment", createdAt: "2026-10-09T13:00:00.000Z", pullNumber: 7,
};
const runToken = "f".repeat(64);

it("invokes a fixed Cloud Run Job with only a scoped run token and bounded execution", async () => {
  let requests = 0;
  const invoker = new CloudRunJobInvoker({
    projectId: "accesswright-dev-123", region: "europe-west3", jobId: "accesswright-worker",
    containerName: "accesswright",
    getAccessToken: () => Promise.resolve("trusted-workload-identity"),
    fetcher: (input, init) => {
      requests++;
      const uri = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      expect(uri.origin).toBe("https://run.googleapis.com");
      expect(uri.pathname).toBe("/v2/projects/accesswright-dev-123/locations/europe-west3/jobs/accesswright-worker:run");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer trusted-workload-identity");
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        overrides: {
          taskCount: number;
          timeout: string;
          containerOverrides: Array<{ name: string; env: Array<{ name: string; value: string }> }>;
        };
      };
      expect(body.overrides.taskCount).toBe(1);
      expect(body.overrides.timeout).toBe("1800s");
      const container = body.overrides.containerOverrides[0];
      expect(container?.name).toBe("accesswright");
      const env = Object.fromEntries(container?.env.map(item => [item.name, item.value]) ?? []);
      expect(env.ACCESSWRIGHT_RUN_ID).toBe(run.runId);
      expect(env.ACCESSWRIGHT_RUN_TOKEN).toBe(runToken);
      expect(env.ACCESSWRIGHT_REPOSITORY).toBe(run.repository);
      expect(env.ACCESSWRIGHT_PR_NUMBER).toBe("7");
      expect(JSON.stringify(body)).not.toMatch(/OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|sk-proj-/);
      return Promise.resolve(Response.json({
        name: "projects/accesswright-dev-123/locations/europe-west3/operations/abcdef",
        done: false,
      }));
    },
  });
  expect(await invoker.start(run, runToken)).toEqual({
    runId: run.runId,
    operation: "projects/accesswright-dev-123/locations/europe-west3/operations/abcdef",
  });
  expect(requests).toBe(1);
});


it("inspects only its own Cloud Run operation without exposing provider diagnostics", async () => {
  const operation = "projects/accesswright-dev-123/locations/europe-west3/operations/abcdef";
  let state = 0;
  const invoker = new CloudRunJobInvoker({
    projectId: "accesswright-dev-123", region: "europe-west3", jobId: "accesswright-worker",
    containerName: "accesswright",
    getAccessToken: () => Promise.resolve("trusted-workload-identity"),
    fetcher: (input, init) => {
      expect(input).toBe("https://run.googleapis.com/v2/" + operation);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer trusted-workload-identity");
      state++;
      if (state === 1) return Promise.resolve(Response.json({ name: operation, done: false }));
      if (state === 2) return Promise.resolve(Response.json({ name: operation, done: true, response: {} }));
      return Promise.resolve(Response.json({ name: operation, done: true, error: { code: 13, message: "sensitive-stacktrace" } }));
    },
  });
  await expect(invoker.inspectOperation("projects/attacker-123/locations/europe-west3/operations/abcdef")).rejects.toThrow(/operation|identity/i);
  expect(state).toBe(0);
  expect(await invoker.inspectOperation(operation)).toEqual({ operation, status: "pending" });
  expect(await invoker.inspectOperation(operation)).toEqual({ operation, status: "succeeded" });
  expect(await invoker.inspectOperation(operation)).toEqual({ operation, status: "failed" });
  expect(state).toBe(3);
});

it("fails closed on oversized streamed Cloud Run operation responses and mismatched identities", async () => {
  const operation = "projects/accesswright-dev-123/locations/europe-west3/operations/abcdef";
  let oversized = true;
  const invoker = new CloudRunJobInvoker({
    projectId: "accesswright-dev-123", region: "europe-west3", jobId: "accesswright-worker",
    containerName: "accesswright",
    getAccessToken: () => Promise.resolve("trusted-workload-identity"),
    fetcher: () => Promise.resolve(oversized
      ? new Response(JSON.stringify({ name: operation, padding: "s".repeat(100_000) }))
      : Response.json({ name: "projects/other-project/locations/europe-west3/operations/evil", done: true })),
  });
  await expect(invoker.inspectOperation(operation)).rejects.toThrow(/size|limit/i);
  oversized = false;
  await expect(invoker.inspectOperation(operation)).rejects.toThrow(/identity/i);
});
it("rejects non-scoped run tokens, invalid job IDs and remote failures without exposing contents", async () => {
  const make = (id: string) => new CloudRunJobInvoker({
    projectId: "accesswright-dev-123", region: "europe-west3", jobId: id,
    containerName: "accesswright",
    getAccessToken: () => Promise.resolve("trusted-workload-identity"),
    fetcher: () => Promise.resolve(new Response("private-source-here", { status: 403 })),
  });
  expect(() => make("../another-job")).toThrow(/job/i);
  await expect(make("accesswright-worker").start(run, "sk-proj-not-a-scoped-token")).rejects.toThrow(/token/i);
  await expect(make("accesswright-worker").start(run, runToken)).rejects.toThrow(/403/);
  await expect(make("accesswright-worker").start(run, runToken)).rejects.not.toThrow(/private-source-here/);
});
