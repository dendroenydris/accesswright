import { expect, it } from "vitest";
import { createSuggestOnlyRepair } from "../../src/llm/suggest-only.js";
import { LlmClient } from "../../src/llm/client.js";
import { BudgetLedger } from "../../src/llm/budget.js";
import type { FixTask } from "../../src/types/schemas.js";

const task: FixTask = { id: "fixture-task", ruleId: "button-name", criterion: "4.1.2", kind: "semantic", route: "llm", source: { file: "Button.tsx", line: 1, column: 1 }, routes: ["/"], violations: [{ ruleId: "button-name", source: { file: "Button.tsx", line: 1, column: 1 }, route: "/", target: ["#save"], impact: "critical", html: '<button id="save" />', failureSummary: "Button has no accessible name" }] };
const source = 'export const Button = () => <button id="save" />;';
const pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 };

it("generates exactly one basic axe/source proposal, without images, guidance, or verifier feedback", async () => {
  const prompts: string[] = [];
  const client = new LlmClient({ generateObject: request => {
    prompts.push(request.prompt);
    expect(request.images).toBeUndefined();
    return Promise.resolve({ object: { taskId: task.id, changes: [{ path: "Button.tsx", before: source, after: source.replace('<button ', '<button aria-label="Wrong action" ') }] }, usage: { inputTokens: 100, outputTokens: 40, costUsd: 0.00018 } });
  } });
  let verified = 0;
  const budget = new BudgetLedger({ maxRunCostUsd: 1, maxTaskTokens: 64000 });
  const repair = createSuggestOnlyRepair({ client, budget, model: { provider: "openai", id: "fixture-model" }, pricing, readSource: () => Promise.resolve(source) });
  const result = await repair(task, () => { verified += 1; return Promise.resolve({ accepted: false, check: "aria-tree", reason: "Do not feed this oracle result back to B1" }); });
  expect(result.status).toBe("needs-human");
  expect(prompts).toHaveLength(1);
  expect(verified).toBe(1);
  expect(prompts[0]).toContain("Button has no accessible name");
  expect(prompts[0]).toContain(source);
  expect(prompts[0]).not.toMatch(/Guidance:|Deterministic context:|Previous attempt|oracle result/);
  expect(budget.snapshot().inputTokens).toBe(100);
});

it("accounts for a rejected schema and never retries or sends a patch outside the mapped file", async () => {
  let calls = 0, verified = 0;
  const client = new LlmClient({ generateObject: () => { calls += 1; return Promise.resolve({ object: { taskId: task.id, changes: [{ path: "Other.tsx", before: source, after: "" }] }, usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.00003 } }); } });
  const budget = new BudgetLedger({ maxRunCostUsd: 1, maxTaskTokens: 64000 });
  const repair = createSuggestOnlyRepair({ client, budget, model: { provider: "openai", id: "fixture-model" }, pricing, readSource: () => Promise.resolve(source) });
  const result = await repair(task, () => { verified += 1; return Promise.resolve({ accepted: true, check: "ok", reason: null }); });
  expect(result.status).toBe("needs-human");
  expect(calls).toBe(1); expect(verified).toBe(0);
  expect(budget.snapshot().outputTokens).toBe(10);
});
