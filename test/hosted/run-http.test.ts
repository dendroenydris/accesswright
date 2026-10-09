import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";

import { HostedRunWorkflow, InMemoryHostedRunStore } from "../../src/hosted/run-workflow.js";
import { createHostedRunHandler } from "../../src/hosted/run-http.js";
import type { RunReport } from "../../src/reporter/report.js";

const valid: RunReport = {
  schemaVersion: 1, startedAt: "2026-10-09T01:00:00.000Z", finishedAt: "2026-10-09T01:01:00.000Z",
  durationMs: 60000, status: "verified", applied: false, fixed: 1, rejected: 0,
  needsHuman: 0, ignored: 0, attempts: 1, providerVerification: "not-run",
  unknownUsage: false, usage: { inputTokens: 0, outputTokens: 0, spentUsd: 0 },
  checks: ["build", "typecheck", "lint", "tests"].map(check => ({
    check: check as "build" | "typecheck" | "lint" | "tests",
    status: "passed" as const, available: true, exitCode: 0, durationMs: 10, failureIds: [],
  })),
  outcomes: [{ id: "id-1", ruleId: "button-name", criterion: "4.1.2", route: "llm", status: "verified", reason: null }],
  final: { acceptedFixIds: ["id-1"], droppedFixIds: [], failures: [] },
};

it("submits and finishes a real HTTP run with independent receipt, without any GitHub writes", async () => {
  let trustedCalls = 0;
  const store = new InMemoryHostedRunStore();
  const workflow = new HostedRunWorkflow({
    store,
    authenticate: (id, token) => {
      if (id !== "run1" || token !== "a".repeat(64)) throw new Error("Run authorization failed");
      return { runId: id, repository: "owner/private", installationId: 42 };
    },
    verifyTrustedResult: (_id, digest) => {
      trustedCalls++;
      return Promise.resolve({ reportDigest: digest, verifiedBaseSha: "f".repeat(40) });
    },
  });
  const server = createServer(createHostedRunHandler(workflow));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No listener");
  const origin = "http://127.0.0.1:" + addr.port;
  const headers = { authorization: "Bearer " + "a".repeat(64), "content-type": "application/json" };
  try {
    const rejected = await fetch(origin + "/runs/run1/results", {
      method: "POST", headers: { ...headers, authorization: "Bearer invalid" }, body: JSON.stringify(valid),
    });
    expect(rejected.status).toBe(401);
    expect(store.get("run1")).toBeUndefined();

    const preflight = await fetch(origin + "/runs/run1/finish", { method: "POST", headers, body: "{}" });
    expect(preflight.status).toBe(409);

    const result = await fetch(origin + "/runs/run1/results", { method: "POST", headers, body: JSON.stringify(valid) });
    expect(result.status).toBe(202);
    expect((await result.json()) as unknown).toMatchObject({ status: "recorded" });

    const complete = await fetch(origin + "/runs/run1/finish", { method: "POST", headers, body: "{}" });
    expect(complete.status).toBe(200);
    expect((await complete.json()) as unknown).toMatchObject({ status: "ready-for-review", verifiedBaseSha: "f".repeat(40) });
    expect(trustedCalls).toBe(1);
    const status = await fetch(origin + "/runs/run1/status", { method: "GET", headers });
    expect(status.status).toBe(200);
    const body = await status.text();
    expect(body).toContain('"status":"ready-for-review"');
    expect(body).not.toContain("Save changes");
    expect(body).not.toContain("a".repeat(64));
    expect((await fetch(origin + "/runs/run1/finish", { method: "POST", headers, body: "{}" })).status).toBe(200);
    expect(trustedCalls).toBe(1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("blocks oversized report bodies before parsing and never echoes content", async () => {
  const workflow = new HostedRunWorkflow({
    store: new InMemoryHostedRunStore(),
    authenticate: () => ({ runId: "run1", repository: "owner/private", installationId: 42 }),
    verifyTrustedResult: () => Promise.resolve(null),
  });
  const server = createServer(createHostedRunHandler(workflow));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No listener");
  const origin = "http://127.0.0.1:" + addr.port;
  try {
    const res = await fetch(origin + "/runs/run1/results", {
      method: "POST", headers: { authorization: "Bearer " + "a".repeat(64), "content-type": "application/json" },
      body: JSON.stringify({ privateSource: "private-marker", payload: "x".repeat(200_000) }),
    });
    expect(res.status).toBe(413);
    expect(await res.text()).not.toContain("private-marker");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
