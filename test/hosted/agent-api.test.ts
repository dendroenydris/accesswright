import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { DurableSpendLedger } from "../../src/llm/durable-spend.js";
import type { LlmProvider } from "../../src/llm/types.js";
import { HostedPatchAgent } from "../../src/hosted/agent-api.js";
import { InMemoryHostedAgentRunStore } from "../../src/hosted/agent-run-store.js";

const temporaryRoots: string[] = [];
const task = {
  id: "llm:4.1.2:button-name:components/Controls.tsx:4:7",
  ruleId: "button-name",
  criterion: "4.1.2",
  kind: "semantic" as const,
  route: "llm" as const,
  source: { file: "components/Controls.tsx", line: 4, column: 7 },
  routes: ["/"],
  violations: [{
    ruleId: "button-name", impact: "serious", route: "/", target: ["#save"],
    html: '<button id="save"></button>', failureSummary: "Button has no name",
    condition: "desktop-light" as const,
    source: { file: "components/Controls.tsx", line: 4, column: 7 },
  }],
};
const context = {
  component: {
    file: "components/Controls.tsx", line: 4, column: 7,
    sourceExcerpt: '<button id="save"></button>',
  },
  callSites: [],
  page: { title: "Settings", surroundingText: "Save changes", caption: null, linkTarget: null },
  screenshotPath: null,
};
async function agent(override?: LlmProvider) {
  const root = await mkdtemp(join(tmpdir(), "aw-hosted-api-"));
  temporaryRoots.push(root);
  const ledger = await DurableSpendLedger.initialize(join(root, "spend.json"), { maxUsd: 1, history: [] });
  let count = 0;
  const provider: LlmProvider = override ?? {
    generateObject: () => {
      count += 1;
      return Promise.resolve({
        object: {
          taskId: task.id,
          changes: [{
            path: "components/Controls.tsx",
            before: '<button id="save"></button>',
            after: '<button id="save" aria-label="Save changes"></button>',
          }],
        },
        usage: { inputTokens: 300, outputTokens: 100, costUsd: 0.0005 },
      });
    },
  };
  const service = new HostedPatchAgent({
    model: { provider: "openai", id: "fixture-only", reasoningEffort: "high" },
    pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    maxInputTokens: 1000,
    maxOutputTokens: 256,
    maxCostUsdPerRun: 0.02,
    ledger,
    provider,
    runStore: new InMemoryHostedAgentRunStore(),
  });
  return { service, ledger, get calls() { return count; } };
}
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("issues run-scoped tokens and returns verified-schema patches without persisting private context", async () => {
  const harness = await agent();
  const token = await harness.service.registerRun({ runId: "run-1", repository: "owner/private-app", installationId: 42 });
  const result = await harness.service.patch("run-1", token, task, context);
  expect(result).toMatchObject({ status: "accepted", patch: { taskId: task.id } });
  expect(harness.calls).toBe(1);
  const records = await harness.service.records();
  expect(records).toHaveLength(1);
  expect(JSON.stringify(records)).not.toContain("Save changes");
  expect(JSON.stringify(records)).not.toContain('<button id="save">');
  expect((await harness.ledger.snapshot()).settledAttempts).toBe(1);
  await expect(harness.service.inspectRun("run-1", "not-the-token")).rejects.toThrow(/authorization/i);
});

it("rejects out-of-context patch paths instead of returning model-suggested arbitrary edits", async () => {
  const harness = await agent({
    generateObject: () => Promise.resolve({
      object: {
        taskId: task.id, changes: [{
          path: "app/secrets.tsx", before: "before", after: "after",
        }],
      },
      usage: { inputTokens: 200, outputTokens: 100, costUsd: 0.0004 },
    }),
  });
  const token = await harness.service.registerRun({ runId: "run-2", repository: "owner/private-app", installationId: 42 });
  const result = await harness.service.patch("run-2", token, task, context);
  expect(result).toMatchObject({ status: "rejected" });
  expect(JSON.stringify(result)).not.toContain("secrets.tsx");
});

it("enforces per-run request caps and does not silently treat unknown model usage as free", async () => {
  const harness = await agent();
  const token = await harness.service.registerRun({ runId: "run-3", repository: "owner/private-app", installationId: 42, maxRequests: 1 });
  expect((await harness.service.patch("run-3", token, task, context)).status).toBe("accepted");
  await expect(harness.service.patch("run-3", token, task, context)).rejects.toThrow(/limit/i);
  expect(harness.calls).toBe(1);

  const failed = await agent({ generateObject: () => Promise.reject(new Error("fixture unknown usage")) });
  const secondToken = await failed.service.registerRun({ runId: "run-4", repository: "owner/private-app", installationId: 42 });
  expect((await failed.service.patch("run-4", secondToken, task, context)).status).toBe("rejected");
  await expect(failed.service.patch("run-4", secondToken, task, context)).rejects.toThrow(/usage|blocked|unknown/i);
  expect((await failed.ledger.snapshot()).unknownAttempts).toBe(1);
});

it("refuses source-sized untrusted payloads before provider invocation", async () => {
  const harness = await agent();
  const token = await harness.service.registerRun({ runId: "run-5", repository: "owner/private-app", installationId: 42 });
  await expect(harness.service.patch("run-5", token, task, {
    ...context,
    component: { ...context.component, sourceExcerpt: "x".repeat(70_000) },
  })).rejects.toThrow(/context|size|limit/i);
  expect(harness.calls).toBe(0);
});
