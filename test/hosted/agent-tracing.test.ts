import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { HostedPatchAgent } from "../../src/hosted/agent-api.js";
import { InMemoryHostedAgentRunStore } from "../../src/hosted/agent-run-store.js";
import { DurableSpendLedger } from "../../src/llm/durable-spend.js";
import { createJsonlLlmObserver } from "../../src/llm/run-record.js";
import { RunRecordSchema } from "../../src/tracer/run-record.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";

const task = { id: "button-name:save", ruleId: "button-name", criterion: "4.1.2", kind: "semantic", route: "llm",
  source: { file: "Controls.tsx", line: 1, column: 1 }, routes: ["/"],
  violations: [{ ruleId: "button-name", impact: "serious", route: "/", target: ["#save"], html: "PRIVATE_SOURCE_CANARY",
    failureSummary: "No name", condition: "desktop-light", source: { file: "Controls.tsx", line: 1, column: 1 } }] };
const context = { component: { file: "Controls.tsx", line: 1, column: 1, sourceExcerpt: "PRIVATE_SOURCE_CANARY" }, callSites: [],
  page: { title: "Private title", surroundingText: "Save changes", caption: null, linkTarget: null }, screenshotPath: null };

it("observes accepted, billed-rejected and unknown Hosted calls once without persisting source or tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "accesswright-agent-trace-"));
  try {
    const ledger = await DurableSpendLedger.initialize(join(root, "spend.json"), { maxUsd: 1, history: [] });
    const provider = new FakeLlmProvider([
      { object: { taskId: task.id, changes: [{ path: "Controls.tsx", before: "PRIVATE_SOURCE_CANARY", after: '<button aria-label="Save" />' }] }, usage: { inputTokens: 300, outputTokens: 100, costUsd: 0.0005 } },
      { object: { taskId: "wrong", changes: [] }, usage: { inputTokens: 300, outputTokens: 100, costUsd: 0.0005 } },
      { error: new Error("PRIVATE_PROVIDER_ERROR_CANARY") },
    ]);
    const path = join(root, "run.jsonl"), observer = createJsonlLlmObserver(path), ids: string[] = [];
    const agent = new HostedPatchAgent({ model: { provider: "openai", id: "fixture-only" }, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      maxInputTokens: 1000, maxOutputTokens: 256, maxCostUsdPerRun: 0.02, provider, providerVerification: "fake-provider",
      ledgerForRun: () => Promise.resolve(ledger), runStore: new InMemoryHostedAgentRunStore(),
      observeCall: (runId, event) => { ids.push(runId); return observer(event); },
    });
    const token = await agent.registerRun({ runId: "run-traced", repository: "owner/private", installationId: 42 });
    expect((await agent.patch("run-traced", token, task, context)).status).toBe("accepted");
    expect((await agent.patch("run-traced", token, task, context)).status).toBe("rejected");
    expect((await agent.patch("run-traced", token, task, context)).status).toBe("rejected");
    expect(ids).toEqual(["run-traced", "run-traced", "run-traced"]);
    const text = await readFile(path, "utf8"), records = text.trim().split("\n").map(line => RunRecordSchema.parse(JSON.parse(line) as unknown));
    expect(records.map(record => record.status)).toEqual(["ok", "rejected", "error"]);
    expect(records.map(record => record.usage?.costUsd)).toEqual([0.0005, 0.0005, undefined]);
    expect(records.every(record => /^[a-f0-9]{64}$/.test(String(record.metadata?.promptHash)))).toBe(true);
    expect(text).not.toMatch(/PRIVATE_|Controls\.tsx|Private title|Save changes/); expect(text).not.toContain(token);
    await expect(agent.patch("run-traced", token, task, context)).rejects.toThrow(/unknown/i);
    expect(provider.requests).toHaveLength(3); expect(ids).toHaveLength(3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("retains settled ledger cost and blocks an uncertain run if its observer fails after the provider responds", async () => {
  const root = await mkdtemp(join(tmpdir(), "accesswright-agent-trace-failure-"));
  try {
    const ledger = await DurableSpendLedger.initialize(join(root, "spend.json"), { maxUsd: 1, history: [] });
    const provider = new FakeLlmProvider([{ object: { taskId: task.id, changes: [{ path: "Controls.tsx", before: "PRIVATE_SOURCE_CANARY", after: '<button aria-label="Save" />' }] },
      usage: { inputTokens: 300, outputTokens: 100, costUsd: 0.0005 } }]);
    const agent = new HostedPatchAgent({ model: { provider: "openai", id: "fixture-only" }, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      maxInputTokens: 1000, maxOutputTokens: 256, maxCostUsdPerRun: 0.02, provider, providerVerification: "fake-provider",
      ledgerForRun: () => Promise.resolve(ledger), runStore: new InMemoryHostedAgentRunStore(),
      observeCall: () => Promise.reject(new Error("Trace storage unavailable")),
    });
    const token = await agent.registerRun({ runId: "run-unconfirmed", repository: "owner/private", installationId: 42 });
    await expect(agent.patch("run-unconfirmed", token, task, context)).rejects.toThrow(/Trace storage/);
    expect(await ledger.snapshot()).toMatchObject({ settledUsd: 0.0005, settledAttempts: 1 });
    await expect(agent.patch("run-unconfirmed", token, task, context)).rejects.toThrow(/unknown/i);
    expect(provider.requests).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
