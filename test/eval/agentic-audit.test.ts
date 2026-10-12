import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { defaults } from "../../src/config.js";
import { runAgentAuditExperiment } from "../../src/eval/agentic-audit.js";
import { BudgetLedger } from "../../src/llm/budget.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";
import type { FakeLlmStep } from "../helpers/fake-provider.js";

const rubric = "Assess the specified criterion from visible and accessible evidence; report observed failures only.";
const input = { schemaVersion: 1, protocolDigest: "a".repeat(64), implementationDigest: "b".repeat(64), rubricDigest: createHash("sha256").update(rubric).digest("hex"), model: { provider: "openai", id: "fake-audit" }, observedAt: "2026-10-12T00:00:00.000Z",
  cases: [{ caseId: "d".repeat(64), criterion: "4.1.2", expertViolation: true, axeViolation: false }, { caseId: "e".repeat(64), criterion: "1.1.1", expertViolation: false, axeViolation: true }] };
const step = (object: unknown, costUsd = 0.001): FakeLlmStep => ({ object, usage: { inputTokens: 10, outputTokens: 10, costUsd } });
async function fixture(steps: FakeLlmStep[]) {
  const root = await mkdtemp(join(tmpdir(), "aw-agent-audit-")), provider = new FakeLlmProvider(steps);
  const options = { provider, budget: new BudgetLedger({ maxRunCostUsd: 1, maxTaskTokens: defaults.maxTaskTokens }), pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, tracePath: join(root, "run.jsonl"), rubric,
    readEvidence: vi.fn(() => Promise.resolve({ text: "PRIVATE_PAGE_FACT", images: [{ data: new Uint8Array([1, 2]), mediaType: "image/png" as const }] })) };
  return { root, options, provider };
}
it("runs read-only fake audit actions, hides labels from prompts and compares both detectors on paired cases", async () => {
  const f = await fixture([step({ action: "read-evidence" }), step({ action: "report", violation: true }), step({ action: "read-evidence" }), step({ action: "report", violation: false })]);
  try {
    const result = await runAgentAuditExperiment(input, f.options);
    expect(result).toMatchObject({ providerEvidence: "fake-provider", pairedCases: 2, unmeasuredCases: 0, labelProvenance: "supplied-expert-labels", axe: { precision: 0, recall: 0 }, agent: { precision: 1, recall: 1 }, usage: { spentUsd: 0.004, unknownUsage: false } });
    expect(result.inputDigest).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(result)).not.toContain("PRIVATE_PAGE_FACT");
    expect(f.provider.requests[0]?.prompt).not.toContain("PRIVATE_PAGE_FACT");expect(f.provider.requests[1]?.images?.[0]?.data).toEqual(new Uint8Array([1, 2]));
    expect(f.provider.requests[0]?.prompt).toContain(rubric);
    expect(f.provider.requests.every(request => !/expertViolation|axeViolation/.test(request.prompt))).toBe(true);
    const trace = await readFile(f.options.tracePath, "utf8");expect(trace).toContain('"step":"agentic-audit"');expect(trace).not.toContain("PRIVATE_PAGE_FACT");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it("keeps absent labels and unknown attempts unmeasured rather than scientific negatives", async () => {
  const f = await fixture([step({ action: "read-evidence" }), step({ action: "report", violation: true }), { error: new Error("Unavailable") }]);
  try { expect(await runAgentAuditExperiment({ ...input, cases: [{ ...input.cases[0], expertViolation: null }, input.cases[1]] }, f.options)).toMatchObject({ pairedCases: 0, unmeasuredCases: 2, axe: { precision: null, recall: null }, agent: { precision: null, recall: null }, usage: { unknownUsage: true } }); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});
it.each([{ action: "report", violation: false }, { action: "shell", command: "anything" }, { action: "read-evidence", path: "../private" }])("rejects unobserved or unsafe actions and retains known fake usage %j", async action => {
  const f = await fixture(Array.from({ length: defaults.evalToolLoopMaxSteps }, () => step(action)));
  try {
    expect(await runAgentAuditExperiment({ ...input, cases: [input.cases[0]] }, f.options)).toMatchObject({ pairedCases: 0, unmeasuredCases: 1, usage: { spentUsd: 0.006, unknownUsage: false } });expect(f.options.readEvidence).not.toHaveBeenCalled();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it("holds unavailable or oversized evidence and never sends a truncated page", async () => {
  const f = await fixture([step({ action: "read-evidence" }), step({ action: "read-evidence" })]);
  try {
    f.options.readEvidence.mockResolvedValueOnce({ text: "x".repeat(defaults.maxContextBytes + 1), images: [] }).mockRejectedValueOnce(new Error("Private detail"));
    const result = await runAgentAuditExperiment(input, f.options);expect(result.cases.map(item => item.reason)).toEqual(["evidence-unavailable", "evidence-unavailable"]);expect(result.pairedCases).toBe(0);
    expect(f.provider.requests).toHaveLength(2);expect(await readFile(f.options.tracePath, "utf8")).not.toContain("Private detail");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it("enforces pre-call and actual settled budgets before reading evidence", async () => {
  const f = await fixture([step({ action: "read-evidence" }, 2)]);
  try {
    const capped = await runAgentAuditExperiment(input, { ...f.options, budget: new BudgetLedger({ maxRunCostUsd: 1, maxTaskTokens: 0 }) });expect(capped.pairedCases).toBe(0);expect(f.provider.requests).toHaveLength(0);
    const actual = await runAgentAuditExperiment(input, f.options);expect(actual.pairedCases).toBe(0);expect(actual.usage.spentUsd).toBe(2);expect(f.options.readEvidence).not.toHaveBeenCalled();expect(f.provider.requests).toHaveLength(1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it("fails before provider access on duplicate/private inputs and uncertain trace acknowledgments", async () => {
  const f = await fixture([step({ action: "read-evidence" })]);
  try {
    await expect(runAgentAuditExperiment({ ...input, cases: [input.cases[0], input.cases[0]] }, f.options)).rejects.toThrow(/Duplicate/);
    await expect(runAgentAuditExperiment({ ...input, source: "private" }, f.options)).rejects.toThrow();
    await expect(runAgentAuditExperiment({ ...input, model: { ...input.model, baseURL: "https://private.invalid" } }, f.options)).rejects.toThrow();
    await expect(runAgentAuditExperiment(input, { ...f.options, rubric: "Changed rubric" })).rejects.toThrow(/frozen/);
    expect(f.provider.requests).toHaveLength(0);
    await expect(runAgentAuditExperiment(input, { ...f.options, tracePath: join(f.root, "missing", "run.jsonl") })).rejects.toThrow();expect(f.provider.requests).toHaveLength(1);expect(f.options.budget.hasUnknownUsage()).toBe(true);expect(f.options.readEvidence).not.toHaveBeenCalled();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
