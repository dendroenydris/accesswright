import { expect, it } from "vitest";

import { CloudTasksRunQueue } from "../../src/hosted/cloud-tasks-queue.js";
import type { QueuedRun } from "../../src/hosted/webhook.js";

const run: QueuedRun = {
  runId: "a".repeat(32),
  repository: "owner/private",
  installationId: 42,
  event: "issue_comment",
  createdAt: "2026-10-09T12:00:00.000Z",
  pullNumber: 7,
};

it("queues exactly one scoped Google Cloud Task with OIDC, no provider/GitHub credentials", async () => {
  let calls = 0;
  const fetcher: typeof fetch = (input, init) => {
    calls++;
    const uri = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    expect(uri.origin).toBe("https://cloudtasks.googleapis.com");
    expect(uri.pathname).toBe("/v2/projects/accesswright-dev-123/locations/europe-west3/queues/repair-jobs/tasks");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local-fixture-identity");
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      task: {
        name: string;
        httpRequest: {
          httpMethod: string;
          url: string;
          body: string;
          oidcToken: { serviceAccountEmail: string; audience: string };
        };
      };
    };
    expect(body.task.name).toContain("tasks/" + run.runId);
    expect(body.task.httpRequest.httpMethod).toBe("POST");
    expect(body.task.httpRequest.url).toBe("https://accesswright-agent-abc-uc.a.run.app/internal/jobs");
    expect(body.task.httpRequest.oidcToken.serviceAccountEmail).toBe("job-dispatch@accesswright-dev-123.iam.gserviceaccount.com");
    const payload = JSON.parse(Buffer.from(body.task.httpRequest.body, "base64").toString("utf8")) as QueuedRun;
    expect(payload).toEqual(run);
    expect(JSON.stringify(body)).not.toContain("local-fixture-identity");
    expect(JSON.stringify(body)).not.toContain("OPENAI_API_KEY");
    return Promise.resolve(Response.json({ name: body.task.name }));
  };
  const queue = new CloudTasksRunQueue({
    projectId: "accesswright-dev-123",
    region: "europe-west3",
    queueId: "repair-jobs",
    targetUrl: "https://accesswright-agent-abc-uc.a.run.app/internal/jobs",
    serviceAccountEmail: "job-dispatch@accesswright-dev-123.iam.gserviceaccount.com",
    getAccessToken: () => Promise.resolve("local-fixture-identity"),
    fetcher,
  });
  expect(await queue.enqueue(run)).toEqual({ status: "queued", runId: run.runId });
  expect(calls).toBe(1);
});

it("handles Cloud Tasks 409 as idempotent duplicate without silent rerun", async () => {
  let calls = 0;
  const queue = new CloudTasksRunQueue({
    projectId: "accesswright-dev-123", region: "europe-west3", queueId: "repair-jobs",
    targetUrl: "https://accesswright-agent-abc-uc.a.run.app/internal/jobs",
    serviceAccountEmail: "job-dispatch@accesswright-dev-123.iam.gserviceaccount.com",
    getAccessToken: () => Promise.resolve("local-fixture-identity"),
    fetcher: () => { calls++; return Promise.resolve(new Response(null, { status: 409 })); },
  });
  expect(await queue.enqueue(run)).toEqual({ status: "duplicate", runId: run.runId });
  expect(calls).toBe(1);
});

it("rejects unsafe target origins and never exposes provider responses on errors", async () => {
  const configure = (url: string) => () => new CloudTasksRunQueue({
    projectId: "accesswright-dev-123", region: "europe-west3", queueId: "repair-jobs",
    targetUrl: url,
    serviceAccountEmail: "job-dispatch@accesswright-dev-123.iam.gserviceaccount.com",
    getAccessToken: () => Promise.resolve("identity"),
  });
  expect(configure("http://localhost:3000/internal/jobs")).toThrow(/target|HTTPS/i);
  expect(configure("https://evil.example.com/internal/jobs")).toThrow(/target|run.app/i);
  const queue = new CloudTasksRunQueue({
    projectId: "accesswright-dev-123", region: "europe-west3", queueId: "repair-jobs",
    targetUrl: "https://accesswright-agent-abc-uc.a.run.app/internal/jobs",
    serviceAccountEmail: "job-dispatch@accesswright-dev-123.iam.gserviceaccount.com",
    getAccessToken: () => Promise.resolve("local-fixture-identity"),
    fetcher: () => Promise.resolve(new Response("private repository source", { status: 403 })),
  });
  await expect(queue.enqueue(run)).rejects.toThrow(/403/);
  await expect(queue.enqueue(run)).rejects.not.toThrow(/private repository source/);
});
