import { expect, it, vi } from "vitest";
import { BudgetLedger } from "../../src/llm/budget.js";
import { LlmClient } from "../../src/llm/client.js";
import { createToolLoopRepair } from "../../src/llm/tool-loop.js";
import { defaults } from "../../src/config.js";
import type { FixTask } from "../../src/types/schemas.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";
import type { FakeLlmStep } from "../helpers/fake-provider.js";

const task: FixTask = { id: "fixture", ruleId: "button-name", criterion: "4.1.2", kind: "semantic", route: "llm", source: { file: "Button.tsx", line: 1, column: 1 }, routes: ["/"],
  violations: [{ ruleId: "button-name", impact: "serious", route: "/", target: ["button"], html: "<button />", failureSummary: "Missing button name", source: null }] };
const patch = { taskId: task.id, changes: [{ path: "Button.tsx", before: "<button />", after: '<button aria-label="Save" />' }] };
const step = (object: unknown, costUsd = 0.001): FakeLlmStep => ({ object, usage: { inputTokens: 10, outputTokens: 10, costUsd } });
const verdict = () => Promise.resolve({ accepted: true, check: "ok" as const, reason: null });
function fixture(steps: FakeLlmStep[]) {
  const provider = new FakeLlmProvider(steps), budget = new BudgetLedger({ maxRunCostUsd: 1, maxTaskTokens: 200000 });
  const options = { client: new LlmClient(provider), budget, model: { provider: "openai" as const, id: "fake-model" }, pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    readSource: vi.fn(() => Promise.resolve("<button />")), allowedPaths: ["Button.tsx"], maxProposals: 3, onTool: vi.fn(() => Promise.resolve()) };
  return { provider, budget, options };
}
it("lets a fake model choose source tools, records each tool and still requires the external verifier", async () => {
  const f = fixture([step({ action: "read-source", path: "Button.tsx" }), step({ action: "propose", patch })]), verify = vi.fn(verdict);
  expect(await createToolLoopRepair(f.options)(task, verify)).toEqual({ status: "accepted" });
  expect(f.options.readSource).toHaveBeenCalledWith("Button.tsx", defaults.maxContextBytes);expect(verify).toHaveBeenCalledWith(patch);
  expect(f.provider.requests[1]?.prompt).toContain("<button />");expect(f.options.onTool).toHaveBeenCalledTimes(2);expect(f.budget.snapshot().spentUsd).toBe(0.002);
});
it("provides structured rejection feedback without bypassing the proposal cap", async () => {
  const f = fixture([step({ action: "propose", patch }), step({ action: "propose", patch })]);
  const verify = vi.fn(() => Promise.resolve({ accepted: false, check: "aria-tree" as const, reason: "Content removed" }));
  expect(await createToolLoopRepair({ ...f.options, maxProposals: 1 })(task, verify)).toMatchObject({ status: "needs-human", reason: "tool-loop-proposal-cap" });
  expect(f.provider.requests).toHaveLength(1);
});
it("passes actual verifier feedback to a second proposal", async () => {
  const f = fixture([step({ action: "propose", patch }), step({ action: "propose", patch })]);
  const verify = vi.fn().mockResolvedValueOnce({ accepted: false, check: "aria-tree", reason: "Content removed" }).mockImplementationOnce(verdict);
  expect(await createToolLoopRepair(f.options)(task, verify)).toHaveProperty("status", "accepted");
  expect(f.provider.requests[1]?.prompt).toContain('"check":"aria-tree","reason":"Content removed"');expect(verify).toHaveBeenCalledTimes(2);
});
it("does not reissue a tool or trace after its acknowledgment is uncertain", async () => {
  const f = fixture([step({ action: "propose", patch }), step({ action: "propose", patch })]), verify = vi.fn(verdict);
  f.options.onTool.mockRejectedValue(new Error("Tool trace unavailable"));
  await expect(createToolLoopRepair(f.options)(task, verify)).rejects.toThrow("Tool trace unavailable");
  expect(verify).toHaveBeenCalledTimes(1);expect(f.options.onTool).toHaveBeenCalledTimes(1);expect(f.provider.requests).toHaveLength(1);expect(f.budget.snapshot().spentUsd).toBe(0.001);
});
it("runs the optional context tool only when selected and transfers actual image bytes", async () => {
  const f = fixture([step({ action: "read-context" }), step({ action: "propose", patch })]);
  const images = [{ data: new Uint8Array([1, 2]), mediaType: "image/png" as const }];
  const readContext = vi.fn(() => Promise.resolve({ context: { component: { file: "Button.tsx", line: 1, column: 1, sourceExcerpt: "<button />" }, callSites: [], page: { title: "Editor", surroundingText: "Save", caption: null, linkTarget: null }, screenshotPath: null }, images }));
  expect(await createToolLoopRepair({ ...f.options, readContext })(task, verdict)).toEqual({ status: "accepted" });
  expect(readContext).toHaveBeenCalledWith(task);expect(f.provider.requests[0]?.images).toEqual([]);expect(f.provider.requests[1]?.images).toEqual(images);
});
it.each([{ action: "read-source", path: "../secret.ts" }, { action: "read-source", path: "Other.tsx" }, { action: "read-source", path: "package.json" },
  { action: "read-context" }, { action: "shell", command: "anything" }, { action: "propose", patch: { ...patch, taskId: "wrong" } },
  { action: "propose", patch: { ...patch, changes: [{ ...patch.changes[0], path: "Other.tsx" }] } }])("rejects unsafe tool actions while retaining their fake usage %j", async action => {
  const f = fixture(Array.from({ length: defaults.evalToolLoopMaxSteps }, () => step(action))), verify = vi.fn(verdict);
  expect(await createToolLoopRepair(f.options)(task, verify)).toMatchObject({ status: "needs-human", reason: "tool-loop-step-cap" });
  expect(f.options.readSource).not.toHaveBeenCalled();expect(verify).not.toHaveBeenCalled();expect(f.budget.snapshot().spentUsd).toBeCloseTo(0.006);expect(f.budget.hasUnknownUsage()).toBe(false);
});
it("stops before a call when tokens are capped and before verification on actual cost overshoot", async () => {
  const f = fixture([step({ action: "propose", patch }, 2)]), verify = vi.fn(verdict);
  expect(await createToolLoopRepair({ ...f.options, budget: new BudgetLedger({ maxRunCostUsd: 1, maxTaskTokens: 0 }) })(task, verify)).toHaveProperty("status", "needs-human");expect(f.provider.requests).toHaveLength(0);
  expect(await createToolLoopRepair(f.options)(task, verify)).toHaveProperty("status", "needs-human");expect(verify).not.toHaveBeenCalled();expect(f.budget.snapshot().spentUsd).toBe(2);
});
it("blocks unknown provider usage and uncertain trace acknowledgments", async () => {
  const f = fixture([{ error: new Error("Provider unavailable") }]);expect(await createToolLoopRepair(f.options)(task, verdict)).toHaveProperty("reason", "tool-loop-unknown-usage");expect(f.budget.hasUnknownUsage()).toBe(true);
  const g = fixture([step({ action: "propose", patch })]);const client = new LlmClient(g.provider, () => { throw new Error("Trace write failed"); });
  await expect(createToolLoopRepair({ ...g.options, client })(task, verdict)).rejects.toThrow("Trace write failed");expect(g.budget.hasUnknownUsage()).toBe(true);
});
it("does not return silently truncated source and stops at the aggregate prompt bound", async () => {
  const f = fixture([step({ action: "read-source", path: "Button.tsx" }), step({ action: "propose", patch })]);f.options.readSource.mockResolvedValue("x".repeat(defaults.maxContextBytes + 1));
  expect(await createToolLoopRepair(f.options)(task, verdict)).toHaveProperty("status", "accepted");expect(f.provider.requests[1]?.prompt).toContain('"source":null');expect(f.options.onTool).toHaveBeenCalledWith(expect.objectContaining({ action: "read-source", status: "rejected" }));
  const g = fixture([]);expect(await createToolLoopRepair({ ...g.options, allowedPaths: ["Button.tsx", "a".repeat(defaults.maxContextBytes) + ".tsx"] })(task, verdict)).toHaveProperty("reason", "tool-loop-context-cap");expect(g.provider.requests).toHaveLength(0);
});
