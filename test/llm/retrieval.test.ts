import { expect, it } from "vitest";
import { retrieveRepairGuidance } from "../../src/llm/retrieval.js";
import { getRepairGuidance } from "../../src/llm/guidance.js";
import { runSemanticRepair } from "../../src/llm/fixer.js";
import { BudgetLedger } from "../../src/llm/budget.js";
import { LlmClient } from "../../src/llm/client.js";
import type { FixTask } from "../../src/types/schemas.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";

const task: FixTask = { id: "fixture", ruleId: "button-name", criterion: "4.1.2", kind: "semantic", route: "llm", source: { file: "Button.tsx", line: 1, column: 1 }, routes: ["/"], violations: [] };
it("retrieves bounded reviewed documents deterministically and binds the actual local corpus", () => {
  const result = retrieveRepairGuidance(task);expect(result.documentIds).toContain("button-name");expect(result.documentIds.length).toBeLessThanOrEqual(2);expect(result.corpusDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(result).toEqual(retrieveRepairGuidance(task));expect(result.guidance).toContain(getRepairGuidance("button-name"));expect(result.corpus).toBe("reviewed-rule-table");
  expect(retrieveRepairGuidance({ ...task, ruleId: "not-a-rule" }).corpusDigest).toBe(result.corpusDigest);
});
it("replaces static guidance only in the selected ablation while preserving structured patch verification", async () => {
  const patch = { taskId: task.id, changes: [{ path: "Button.tsx", before: "<button />", after: '<button aria-label="Save" />' }] };
  const provider = new FakeLlmProvider([{ object: patch, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }]);
  const guidance = retrieveRepairGuidance(task).guidance;
  expect(await runSemanticRepair({ client: new LlmClient(provider), budget: new BudgetLedger({ maxRunCostUsd: 1, maxTaskTokens: 10000 }), task,
    context: { component: { ...task.source ?? { file: "Button.tsx", line: 1, column: 1 }, sourceExcerpt: "<button />" }, callSites: [], page: { title: null, surroundingText: "", caption: null, linkTarget: null }, screenshotPath: null },
    model: { provider: "openai", id: "fake-model" }, estimate: { estimatedInputTokens: 100, maxOutputTokens: 100, estimatedCostUsd: 0 }, guidance, verifyPatch: () => Promise.resolve({ accepted: true }) })).toHaveProperty("status", "accepted");
  expect(provider.requests[0]?.prompt).toContain(`Guidance: ${guidance}`);
});
