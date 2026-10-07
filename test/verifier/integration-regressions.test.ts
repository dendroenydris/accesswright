import { describe, expect, it } from "vitest";
import { verifyPerPatch } from "../../src/verifier/per-patch.js";
import { verifyFinal } from "../../src/verifier/final.js";
import type { FinalCheckSnapshot } from "../../src/verifier/final.js";
import type { FixTask } from "../../src/types/schemas.js";

const item = { ruleId: "image-alt", impact: "critical", route: "/", target: ["#chart"], html: "<img>", failureSummary: null, source: { file: "app/page.tsx", line: 1, column: 1 } };
const task: FixTask = { id: "fix-image", ruleId: "image-alt", criterion: "1.1.1", kind: "semantic", route: "llm", source: item.source, routes: ["/"], violations: [item] };
const empty: FinalCheckSnapshot = { build: [], typecheck: [], lint: [], tests: [], violations: [] };
describe("real integration acceptance regressions", () => {
  it("does not confuse an image without alt with a proven decorative icon", () => {
    expect(verifyPerPatch({ task, before: { violations: [item], aria: [{ id: "chart", role: "img", name: "", text: "", interactive: false, protectedContent: true }], probeFailures: [] }, after: { violations: [], aria: [], probeFailures: [] } }).accepted).toBe(false);
  });
  it("differentiates existing and newly introduced runtime probe failures", () => {
    expect(verifyPerPatch({ task, before: { violations: [item], aria: [], probeFailures: ["pre-existing-hover"] }, after: { violations: [], aria: [], probeFailures: ["pre-existing-hover"] } }).accepted).toBe(true);
    expect(verifyPerPatch({ task, before: { violations: [item], aria: [], probeFailures: [] }, after: { violations: [], aria: [], probeFailures: ["new-focus"] } }).accepted).toBe(false);
  });
  it("does not count a target becoming inconclusive as a repair", () => {
    expect(verifyPerPatch({ task, before: { violations: [item], aria: [], probeFailures: [] }, after: { violations: [], incomplete: [item], aria: [], probeFailures: [] } }).accepted).toBe(false);
  });
  it("detects an additional occurrence of a baseline build failure", async () => {
    const result = await verifyFinal({ baseline: { ...empty, build: ["same-error"] }, fixIds: ["a"], runChecks: ids => Promise.resolve({ ...empty, build: ids.length ? ["same-error", "same-error"] : ["same-error"] }), rerunTests: () => Promise.resolve([]) });
    expect(result.droppedFixIds).toEqual(["a"]);
  });
  it("rejects a new test failure on rerun even when its identifier differs", async () => {
    const result = await verifyFinal({ baseline: empty, fixIds: ["a"], runChecks: ids => Promise.resolve({ ...empty, tests: ids.length ? ["failure-A"] : [] }), rerunTests: ids => Promise.resolve(ids.length ? ["failure-B"] : []) });
    expect(result.acceptedFixIds).toEqual([]);
    expect(result.droppedFixIds).toEqual(["a"]);
  });
});
