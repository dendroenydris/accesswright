import { expect, it } from "vitest";
import { unresolvedProductionTargets } from "../../src/verifier/production-targets.js";
import type { FixTask, Violation } from "../../src/types/schemas.js";

const violation: Violation = { ruleId: "button-name", route: "/", condition: "desktop-light", target: ["#save"], html: "<button id=save></button>", impact: "critical", failureSummary: null, source: { file: "app/page.tsx", line: 1, column: 1 } };
const task: FixTask = { id: "verified-in-dev", ruleId: "button-name", criterion: "4.1.2", kind: "semantic", route: "llm", source: violation.source, routes: ["/"], violations: [violation] };

it("rejects a dev-accepted target that still fails in production even when it was already in the production baseline", () => {
  expect(unresolvedProductionTargets([task], { violations: [violation], incomplete: [], aria: [], probeFailures: [] })).toEqual([expect.stringMatching(/^production-target:/)]);
});
it("does not call a production inconclusive target fixed", () => {
  expect(unresolvedProductionTargets([task], { violations: [], incomplete: [violation], aria: [], probeFailures: [] })).toHaveLength(1);
});
it("does not blame unselected groups or unrelated pre-existing findings", () => {
  const after = { violations: [{ ...violation, target: ["#other"] }], aria: [], probeFailures: [] };
  expect(unresolvedProductionTargets([task], after)).toEqual([]);
  expect(unresolvedProductionTargets([], { ...after, violations: [violation] })).toEqual([]);
});
it("matches identities without relying on development-only source coordinates", () => {
  expect(unresolvedProductionTargets([task], { violations: [{ ...violation, source: null }], aria: [], probeFailures: [] })).toHaveLength(1);
});
