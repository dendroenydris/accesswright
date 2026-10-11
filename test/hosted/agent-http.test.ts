import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { HostedPatchAgent } from "../../src/hosted/agent-api.js";
import { InMemoryHostedAgentRunStore } from "../../src/hosted/agent-run-store.js";
import { createHostedAgentServer } from "../../src/hosted/agent-http.js";
import { InMemoryHostedRunStore } from "../../src/hosted/run-workflow.js";
import { DurableSpendLedger } from "../../src/llm/durable-spend.js";
import type { LlmProvider } from "../../src/llm/types.js";
import type { RunReport } from "../../src/reporter/report.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";

const roots: string[] = [];
const task = {
  id: "llm:4.1.2:button-name:components/Controls.tsx:4:7",
  ruleId: "button-name", criterion: "4.1.2", kind: "semantic", route: "llm",
  source: { file: "components/Controls.tsx", line: 4, column: 7 },
  routes: ["/"], violations: [{
    ruleId: "button-name", impact: "serious", route: "/", target: ["#save"],
    html: '<button id="save"></button>', failureSummary: "No accessible button name",
    condition: "desktop-light", source: { file: "components/Controls.tsx", line: 4, column: 7 },
  }],
};
const context = {
  component: { file: "components/Controls.tsx", line: 4, column: 7, sourceExcerpt: '<button id="save"></button>' },
  callSites: [], page: { title: "Settings", surroundingText: "Save changes", caption: null, linkTarget: null },
  screenshotPath: null,
};

async function fixture(providerOverride?: LlmProvider) {
  const root = await mkdtemp(join(tmpdir(), "aw-hosted-http-"));
  roots.push(root);
  const ledger = await DurableSpendLedger.initialize(join(root, "spend.json"), { maxUsd: 1, history: [] });
  const fake = new FakeLlmProvider([{
    object: { taskId: task.id, changes: [{ path: "components/Controls.tsx", before: '<button id="save"></button>', after: '<button id="save" aria-label="Save changes"></button>' }] },
    usage: { inputTokens: 250, outputTokens: 80, costUsd: 0.00041 },
  }]);
  const provider = providerOverride ?? fake;
  const service = new HostedPatchAgent({
    model: { provider: "openai", id: "fixture-only", reasoningEffort: "high" },
    pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    maxInputTokens: 1200, maxOutputTokens: 256, maxCostUsdPerRun: 0.02,
    ledgerForRun: () => Promise.resolve(ledger), provider, runStore: new InMemoryHostedAgentRunStore(),
  });
  const token = await service.registerRun({ runId: "run-9", repository: "owner/repo", installationId: 42, maxRequests: 1 });
  const runStore = new InMemoryHostedRunStore();
  let trustedCalls = 0;
  const server = createHostedAgentServer({ agent: service, store: runStore,
    verifyTrustedResult: () => { trustedCalls++; return Promise.resolve(null); } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Agent server missing TCP port");
  return {
    service, token, ledger, server, runStore, get calls() { return fake.requests.length; }, get trustedCalls() { return trustedCalls; },
    origin: "http://127.0.0.1:" + address.port,
    endpoint: "http://127.0.0.1:" + address.port + "/runs/run-9/tasks/" + encodeURIComponent(task.id) + "/patch",
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("shares scoped authentication across patch, result and finish endpoints without trusting job reports", async () => {
  const f = await fixture();
  const otherToken = await f.service.registerRun({ runId: "run-other", repository: "owner/other", installationId: 43 });
  const headers = { authorization: "Bearer " + f.token, "content-type": "application/json" };
  const report: RunReport = {
    schemaVersion: 1, startedAt: "2026-10-11T01:00:00.000Z", finishedAt: "2026-10-11T01:01:00.000Z",
    durationMs: 60000, status: "verified", applied: false, fixed: 1, rejected: 0,
    needsHuman: 0, ignored: 0, attempts: 1, providerVerification: "fake-provider", unknownUsage: false,
    usage: { inputTokens: 250, outputTokens: 80, spentUsd: 0.00041 },
    checks: ["build", "typecheck", "lint", "tests"].map(check => ({
      check: check as "build" | "typecheck" | "lint" | "tests", available: true,
      status: "passed" as const, exitCode: 0, durationMs: 1, failureIds: [],
    })),
    outcomes: [{ id: task.id, ruleId: task.ruleId, criterion: task.criterion, route: "llm", status: "verified", reason: null }],
    final: { acceptedFixIds: [task.id], droppedFixIds: [], failures: [] },
  };
  try {
    for (const action of ["results", "finish", "status"]) {
      const unauthorized = await fetch(f.origin + "/runs/run-9/" + action, {
        method: action === "status" ? "GET" : "POST",
        headers: { ...headers, authorization: "Bearer " + otherToken },
        ...(action === "status" ? {} : { body: JSON.stringify(report) }),
      });
      expect(unauthorized.status).toBe(401);
      await unauthorized.arrayBuffer();
    }
    expect(f.runStore.get("run-9")).toBeUndefined();
    const patch = await fetch(f.endpoint, { method: "POST", headers, body: JSON.stringify({ task, context }) });
    expect(patch.status).toBe(200);
    await patch.arrayBuffer();
    const submitted = await fetch(f.origin + "/runs/run-9/results", { method: "POST", headers, body: JSON.stringify(report) });
    expect(submitted.status).toBe(202);
    await submitted.arrayBuffer();
    const finished = await fetch(f.origin + "/runs/run-9/finish", { method: "POST", headers, body: "{}" });
    expect(finished.status).toBe(409);
    expect(await finished.json()).toMatchObject({ status: "blocked" });
    expect(f.trustedCalls).toBe(1);
    expect(f.calls).toBe(1);
    const status = await fetch(f.origin + "/runs/run-9/status", { headers });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ repository: "owner/repo", installationId: 42, status: "blocked" });
    const stored = JSON.stringify(f.runStore.get("run-9"));
    expect(stored).not.toContain(context.component.sourceExcerpt);
    expect(stored).not.toContain(f.token);
    expect(stored).not.toContain("Save changes");
    for (const path of ["/github/webhook", "/internal/jobs"]) {
      const response = await fetch(f.origin + path, { method: "POST", headers, body: "{}" });
      expect(response.status).toBe(404);
      await response.arrayBuffer();
    }
  } finally { await new Promise<void>(resolve => f.server.close(() => resolve())); }
});

it("accepts only authenticated per-run task requests and consumes the durable budget", async () => {
  const f = await fixture();
  try {
    const response = await fetch(f.endpoint, {
      method: "POST", headers: { authorization: "Bearer " + f.token, "content-type": "application/json" },
      body: JSON.stringify({ task, context }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({ status: "accepted", patch: { taskId: task.id } });
    expect(f.calls).toBe(1);
    expect((await f.ledger.snapshot()).settledAttempts).toBe(1);

    const second = await fetch(f.endpoint, {
      method: "POST", headers: { authorization: "Bearer " + f.token, "content-type": "application/json" },
      body: JSON.stringify({ task, context }),
    });
    expect(second.status).toBe(429);
    expect(f.calls).toBe(1);
  } finally { await new Promise<void>(resolve => f.server.close(() => resolve())); }
});

it("rejects bad tokens, mismatched task IDs and oversized inputs before any provider calls", async () => {
  const f = await fixture();
  try {
    const headers = { authorization: "Bearer " + "0".repeat(64), "content-type": "application/json" };
    const unauth = await fetch(f.endpoint, { method: "POST", headers, body: JSON.stringify({ task, context }) });
    expect(unauth.status).toBe(401);
    const mismatched = await fetch(f.endpoint.replace(encodeURIComponent(task.id), "unrelated-task"), {
      method: "POST", headers: { ...headers, authorization: "Bearer " + f.token },
      body: JSON.stringify({ task, context }),
    });
    expect(mismatched.status).toBe(400);
    const oversized = await fetch(f.endpoint, {
      method: "POST", headers: { ...headers, authorization: "Bearer " + f.token },
      body: JSON.stringify({ task, context: { ...context, component: { ...context.component, sourceExcerpt: "x".repeat(80_000) } } }),
    });
    expect(oversized.status).toBe(413);
    expect(f.calls).toBe(0);
    expect(await unauth.text()).not.toContain("Save changes");
  } finally { await new Promise<void>(resolve => f.server.close(() => resolve())); }
});

it("returns only safe rejection metadata when the model proposes an unauthorized patch path", async () => {
  const f = await fixture({
    generateObject: () => Promise.resolve({
      object: { taskId: task.id, changes: [{ path: "app/secrets.tsx", before: "before", after: "after" }] },
      usage: { inputTokens: 200, outputTokens: 70, costUsd: 0.00034 },
    }),
  });
  try {
    const response = await fetch(f.endpoint, {
      method: "POST",
      headers: { authorization: "Bearer " + f.token, "content-type": "application/json" },
      body: JSON.stringify({ task, context }),
    });
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain("rejected");
    expect(body).not.toContain("secrets.tsx");
    expect(body).not.toContain("Save changes");
  } finally { await new Promise<void>(resolve => f.server.close(() => resolve())); }
});
