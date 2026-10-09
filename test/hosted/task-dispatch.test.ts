import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";

import { CloudRunTaskDispatcher, createCloudRunTaskHandler } from "../../src/hosted/task-dispatch.js";
import type { QueuedRun } from "../../src/hosted/webhook.js";

const run: QueuedRun = {
  runId: "a".repeat(32), repository: "owner/private", installationId: 42,
  event: "issue_comment", createdAt: "2026-10-09T12:00:00.000Z", pullNumber: 7,
};
function fixture() {
  const claimed = new Set<string>();
  let registered = 0, started = 0, authorized = true, failJob = false;
  const dispatcher = new CloudRunTaskDispatcher({
    authenticateTask: () => Promise.resolve(authorized),
    claim: input => {
      if (claimed.has(input.runId)) return Promise.resolve(false);
      claimed.add(input.runId);
      return Promise.resolve(true);
    },
    registerRunToken: () => { registered++; return Promise.resolve("f".repeat(64)); },
    invokeJob: (input, token) => {
      expect(input).toEqual(run);
      expect(token).toBe("f".repeat(64));
      started++;
      return failJob ? Promise.reject(new Error("provider unavailable")) :
        Promise.resolve({ runId: input.runId, operation: "projects/p/locations/europe-west3/operations/abc" });
    },
    recordOutcome: () => Promise.resolve(),
  });
  return {
    dispatcher, setAuthorized(value: boolean) { authorized = value; },
    setFailure(value: boolean) { failJob = value; },
    get started() { return started; }, get registered() { return registered; },
  };
}

it("accepts only authenticated Cloud Tasks dispatches, never hands model or GitHub keys to jobs", async () => {
  const f = fixture(), server = createServer(createCloudRunTaskHandler(f.dispatcher));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No server port");
  const url = "http://127.0.0.1:" + addr.port + "/internal/jobs";
  try {
    f.setAuthorized(false);
    const denied = await fetch(url, { method: "POST", headers: { authorization: "Bearer invalid", "content-type": "application/json" }, body: JSON.stringify(run) });
    expect(denied.status).toBe(401);
    expect(f.started).toBe(0);
    f.setAuthorized(true);
    const [first, again] = await Promise.all([
      fetch(url, { method: "POST", headers: { authorization: "Bearer signed-oidc-fixture", "content-type": "application/json" }, body: JSON.stringify(run) }),
      fetch(url, { method: "POST", headers: { authorization: "Bearer signed-oidc-fixture", "content-type": "application/json" }, body: JSON.stringify(run) }),
    ]);
    expect([first.status, again.status].sort()).toEqual([200, 202]);
    expect(f.registered).toBe(1);
    expect(f.started).toBe(1);
    const response = (await first.text()) + (await again.text());
    expect(response).not.toContain("f".repeat(64));
    expect(response).not.toContain("OPENAI_API_KEY");
    expect(response).not.toContain("GITHUB_TOKEN");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("does not duplicate a launch after uncertain Cloud Run invocation failure", async () => {
  const f = fixture();
  f.setFailure(true);
  await expect(f.dispatcher.dispatch(run, "Bearer fixture")).rejects.toThrow(/unavailable/);
  f.setFailure(false);
  expect(await f.dispatcher.dispatch(run, "Bearer fixture")).toMatchObject({ status: "duplicate" });
  expect(f.started).toBe(1);
  expect(f.registered).toBe(1);
});

it("rejects invalid run metadata and oversized HTTP requests before claiming a run", async () => {
  const f = fixture();
  const server = createServer(createCloudRunTaskHandler(f.dispatcher));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Missing listener");
  const url = "http://127.0.0.1:" + addr.port + "/internal/jobs";
  try {
    const big = await fetch(url, { method: "POST", headers: { authorization: "Bearer signed-oidc-fixture", "content-type": "application/json" }, body: JSON.stringify({ ...run, source: "x".repeat(90_000) }) });
    expect(big.status).toBe(413);
    const invalid = await fetch(url, { method: "POST", headers: { authorization: "Bearer signed-oidc-fixture", "content-type": "application/json" }, body: JSON.stringify({ ...run, repository: "../../bad" }) });
    expect(invalid.status).toBe(400);
    expect(f.started).toBe(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
