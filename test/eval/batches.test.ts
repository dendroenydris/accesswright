import { expect, it } from "vitest";
import { generateMutations } from "../../src/eval/operators.js";
import { planCaseBatches, taskMatchesCases } from "../../src/eval/batches.js";
import type { RenderedCase } from "../../src/eval/cases.js";
import type { FixTask } from "../../src/types/schemas.js";

const mutations = generateMutations("app/page.tsx", 'export function One(){return <button id="one" aria-label="Save"/>;} export function Two(){return <a id="two" href="/help" aria-label="Help"/>;}');
const cases: RenderedCase[] = mutations.map(mutation => ({ mutation, references: [{ route: "/", condition: "desktop-light", nodeId: `node-${mutation.literalId ?? "unknown"}`, target: [`#${mutation.literalId ?? "unknown"}`], role: "button", name: "Save", text: "", interactive: true, language: "en" }], observedTargets: [] }));

it("freezes seeded case order before outcomes and batches only disjoint components", () => {
  const batches = planCaseBatches(cases, 1, 30);
  expect(batches.flat().map(item => item.mutation.id).sort()).toEqual(cases.map(item => item.mutation.id).sort());
  for (const batch of batches) expect(new Set(batch.map(item => item.mutation.component)).size).toBe(batch.length);
  expect(planCaseBatches([...cases].reverse(), 1, 30)).toEqual(batches);
  expect(planCaseBatches(cases, 1, 2).flat()).toHaveLength(2);
});

it("selects a seeded target by rule and actual observed selector, not every pre-existing rule match", () => {
  const item = cases.find(item => item.mutation.operator === "remove-button-name");
  if (!item) throw new Error("Missing fixture operator");
  const task: FixTask = { id: "task", ruleId: "button-name", criterion: "4.1.2", kind: "semantic", route: "llm", source: item.mutation.source, routes: ["/"], violations: [{ ruleId: "button-name", route: "/", condition: "desktop-light", target: ["#one"], html: "", failureSummary: null, impact: "critical", source: item.mutation.source }] };
  item.observedTargets = task.violations;
  expect(taskMatchesCases(task, [item])).toBe(true);
  expect(taskMatchesCases({ ...task, violations: task.violations.map(v => ({ ...v, target: ["#other"] })) }, [item])).toBe(false);
});
