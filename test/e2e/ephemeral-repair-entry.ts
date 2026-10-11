import assert from "node:assert/strict";
import { once } from "node:events";
import { access, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { HostedPatchAgent } from "../../src/hosted/agent-api.js";
import { createHostedAgentServer } from "../../src/hosted/agent-http.js";
import { InMemoryHostedAgentRunStore } from "../../src/hosted/agent-run-store.js";
import { InMemoryHostedRunStore } from "../../src/hosted/run-workflow.js";
import { runHostedWorkerEntry } from "../../src/hosted/worker-entry.js";
import { DurableSpendLedger } from "../../src/llm/durable-spend.js";
import type { LlmProvider } from "../../src/llm/types.js";
import { FixTaskSchema } from "../../src/types/schemas.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";

const ledgerPath = "/tmp/owned-worker-spend.json";
const ledger = await DurableSpendLedger.initialize(ledgerPath, { maxUsd: 0.1, history: [] });
let fakeProviderCalls = 0;
// Loopback fake service exercises transport only; a separate Docker verifier holds review authority.
const provider: LlmProvider = { generateObject: (request, schema) => {
  fakeProviderCalls++;
  const input = z.object({ task: FixTaskSchema }).passthrough().parse(JSON.parse(request.prompt.split("\n").at(-1) ?? "null"));
  assert.equal(input.task.ruleId, "button-name");
  const fake = new FakeLlmProvider([{ object: { taskId: input.task.id, changes: [{ path: "components/Controls.tsx",
    before: 'id="unlabeled" type="button"', after: 'id="unlabeled" type="button" aria-label="Save changes"' }] },
    usage: { inputTokens: 300, outputTokens: 100, costUsd: 0.0005 } }]);
  return fake.generateObject(request, schema);
} };
const agent = new HostedPatchAgent({ model: { provider: "openai", id: "fixture-only", reasoningEffort: "high" },
  pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, maxInputTokens: 1000, maxOutputTokens: 256, maxCostUsdPerRun: 0.02,
  provider, providerVerification: "fake-provider", runStore: new InMemoryHostedAgentRunStore(), ledgerForRun: () => Promise.resolve(ledger) });
const token = await agent.registerRun({ runId: "worker-fixture", repository: "owned/fixture", installationId: 42, expiresInSeconds: 3600 });
const server = createHostedAgentServer({ agent, store: new InMemoryHostedRunStore(), verifyTrustedResult: () => Promise.resolve(null), receiveCandidate: async (runId, candidate) => {
  assert.equal(runId, "worker-fixture");
  assert.notEqual(process.getuid?.(), 0);
  assert.deepEqual(await readdir("/workspace"), []);
  for (const name of (await readdir("/tmp/accesswright")).filter(name => name.startsWith("repair-run-"))) {
    await assert.rejects(access(join("/tmp/accesswright", name, "source")), { code: "ENOENT" });
  }
  assert.equal(candidate.report.fixed, 3);
  assert.equal(candidate.report.status, "verified");
  assert.equal(fakeProviderCalls, 1);
  assert(candidate.report.checks.every(check => check.status === "passed" && check.available));
  assert.deepEqual({ usage: candidate.report.usage, unknownUsage: candidate.report.unknownUsage, providerVerification: candidate.report.providerVerification }, await agent.sealForVerification("worker-fixture"));
  // Owned fixture transfer only; the outer test deletes the payload and container.
  await writeFile("/tmp/owned-candidate.json", JSON.stringify(candidate), { mode: 0o600, flag: "wx" });
} });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("Fixture service has no port");
try {
  process.env.ACCESSWRIGHT_RUN_ID = "worker-fixture";
  process.env.ACCESSWRIGHT_RUN_TOKEN = token;
  process.env.ACCESSWRIGHT_AGENT_ORIGIN = "http://127.0.0.1:" + address.port;
  process.env.ACCESSWRIGHT_PROVIDER_VERIFICATION = "fake-provider";
  await runHostedWorkerEntry();
  console.log(JSON.stringify({ kind: "owned-secretless-semantic-worker", privateSourceRemoved: true, paidCalls: 0, fakeProviderCalls }));
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(ledgerPath, { force: true });
}
