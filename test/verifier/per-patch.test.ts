import { describe, expect, it } from "vitest";

import { verifyPerPatch } from "../../src/verifier/per-patch.js";
import type {
  AccessibleNodeFact,
  PageVerificationState,
} from "../../src/verifier/per-patch.js";
import type { FixTask, Violation } from "../../src/types/schemas.js";

function violation(
  ruleId = "aria-valid-attr",
  target = "[aria-bogus]",
): Violation {
  return {
    ruleId,
    impact: "critical",
    route: "/",
    target: [target],
    html: '<div aria-bogus="x">Visible</div>',
    failureSummary: "fixture",
    source: { file: "app/page.tsx", line: 4, column: 7 },
  };
}

function task(ruleId = "aria-valid-attr"): FixTask {
  const item = violation(ruleId, ruleId === "aria-valid-attr" ? "[aria-bogus]" : "#target");
  return {
    id: `test:${ruleId}`,
    ruleId,
    criterion: "test",
    kind: ruleId === "color-contrast" ? "layout" : "syntactic",
    route: ruleId === "color-contrast" ? "optimizer" : "codemod",
    source: item.source,
    routes: ["/"],
    violations: [item],
  };
}

function node(overrides: Partial<AccessibleNodeFact> = {}): AccessibleNodeFact {
  return {
    id: "app/page.tsx:4:7",
    role: "generic",
    name: "",
    text: "Visible",
    interactive: false,
    ...overrides,
  };
}

function state(
  violations: Violation[],
  aria: AccessibleNodeFact[] = [node()],
  probeFailures: string[] = [],
): PageVerificationState {
  return { violations, aria, probeFailures };
}

describe("verifyPerPatch", () => {
  it("accepts when the target is gone, no new violation exists, and aria facts are preserved", () => {
    expect(
      verifyPerPatch({
        task: task(),
        before: state([violation()]),
        after: state([]),
      }),
    ).toEqual({ accepted: true, check: "ok", reason: null });
  });

  it("rejects when the target violation remains", () => {
    expect(
      verifyPerPatch({
        task: task(),
        before: state([violation()]),
        after: state([violation()]),
      }),
    ).toMatchObject({ accepted: false, check: "target" });
  });

  it("rejects a newly introduced violation", () => {
    expect(
      verifyPerPatch({
        task: task(),
        before: state([violation()]),
        after: state([violation("button-name", "button")]),
      }),
    ).toMatchObject({ accepted: false, check: "new-violation" });
  });

  it("rejects removal of visible text", () => {
    expect(
      verifyPerPatch({
        task: task(),
        before: state([violation()], [node()]),
        after: state([], []),
      }),
    ).toMatchObject({ accepted: false, check: "aria-tree" });
  });

  it("rejects removal of an interactive element even when it has no text", () => {
    expect(
      verifyPerPatch({
        task: task(),
        before: state(
          [violation()],
          [node({ role: "button", text: "", name: "Open", interactive: true })],
        ),
        after: state([], []),
      }),
    ).toMatchObject({ accepted: false, check: "aria-tree" });
  });

  it("allows a nameless textless non-interactive decorative node to disappear", () => {
    expect(
      verifyPerPatch({
        task: task(),
        before: state(
          [violation()],
          [node({ role: "img", text: "", name: "", interactive: false })],
        ),
        after: state([], []),
      }),
    ).toMatchObject({ accepted: true });
  });

  it("rejects role changes for ordinary rules", () => {
    expect(
      verifyPerPatch({
        task: task(),
        before: state([violation()], [node({ role: "navigation" })]),
        after: state([], [node({ role: "generic" })]),
      }),
    ).toMatchObject({ accepted: false, check: "aria-tree" });
  });

  it("allows a role change when the rule declares it", () => {
    const beforeViolation = violation("landmark-unique", "nav");
    const landmarkTask: FixTask = {
      ...task("landmark-unique"),
      kind: "global",
      route: "human",
      violations: [beforeViolation],
    };

    expect(
      verifyPerPatch({
        task: landmarkTask,
        before: state([beforeViolation], [node({ role: "navigation" })]),
        after: state([], [node({ role: "generic" })]),
      }),
    ).toMatchObject({ accepted: true });
  });

  it("rejects heading-level changes unless the rule declares them", () => {
    expect(
      verifyPerPatch({
        task: task(),
        before: state([violation()], [node({ role: "heading", headingLevel: 4 })]),
        after: state([], [node({ role: "heading", headingLevel: 3 })]),
      }),
    ).toMatchObject({ accepted: false, check: "aria-tree" });
  });

  it("allows heading-level changes for heading-order", () => {
    const beforeViolation = violation("heading-order", "h4");
    const headingTask: FixTask = {
      ...task("heading-order"),
      kind: "global",
      route: "human",
      violations: [beforeViolation],
    };

    expect(
      verifyPerPatch({
        task: headingTask,
        before: state([beforeViolation], [node({ role: "heading", headingLevel: 4 })]),
        after: state([], [node({ role: "heading", headingLevel: 3 })]),
      }),
    ).toMatchObject({ accepted: true });
  });

  it("rejects any dynamic verifier probe failure", () => {
    expect(
      verifyPerPatch({
        task: task("color-contrast"),
        before: state([violation("color-contrast", ".text")]),
        after: state([], [node()], ["interaction-contrast"]),
      }),
    ).toMatchObject({ accepted: false, check: "probe" });
  });
});
