import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { HostedPatchAgent } from "../../src/hosted/agent-api.js";
import { InMemoryHostedAgentRunStore } from "../../src/hosted/agent-run-store.js";
import { createHostedAgentHandler } from "../../src/hosted/agent-http.js";
import { DurableSpendLedger } from "../../src/llm/durable-spend.js";
import type { LlmProvider } from "../../src/llm/types.js";

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
  let calls = 0;
  const provider: LlmProvider = providerOverride ?? {
    generateObject: () => {
      calls += 1;
      return Promise.resolve({
        object: { taskId: task.id, changes: [{ path: "components/Controls.tsx", before: '<button id="save"></button>', after: '<button id="save" aria-label="Save changes"></button>' }] },
        usage: { inputTokens: 250, outputTokens: 80, costUsd: 0.00041 },
      });
    },
  };
  const service = new HostedPatchAgent({
    model: { provider: "openai", id: "fixture-only", reasoningEffort: "high" },
    pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    maxInputTokens: 1200, maxOutputTokens: 256, maxCostUsdPerRun: 0.02,
    ledgerForRun: () => Promise.resolve(ledger), provider, runStore: new InMemoryHostedAgentRunStore(),
  });
  const token = await service.registerRun({ runId: "run-9", repository: "owner/repo", installationId: 42, maxRequests: 1 });
  const server = createServer(createHostedAgentHandler(service));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Agent server missing TCP port");
  return {
    service, token, ledger, server, get calls() { return calls; },
    endpoint: "http://127.0.0.1:" + address.port + "/runs/run-9/tasks/" + encodeURIComponent(task.id) + "/patch",
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
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
