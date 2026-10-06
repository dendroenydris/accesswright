import { describe, expect, it } from "vitest";

import { verifyPerPatch } from "../../src/verifier/per-patch.js";
import type {
  AccessibleNodeFact,
  PageVerificationState,
} from "../../src/verifier/per-patch.js";
import type { FixTask, Violation } from "../../src/types/schemas.js";

function violation(
  ruleId: string,
  target: string,
  sourceLine = 4,
): Violation {
  return {
    ruleId,
    impact: "critical",
    route: "/",
    target: [target],
    html: "<div>fixture</div>",
    failureSummary: "fixture",
    source: { file: "app/page.tsx", line: sourceLine, column: 7 },
  };
}

function task(ruleId: string): FixTask {
  const item = violation(ruleId, "#target");
  const global = ruleId === "landmark-unique" || ruleId === "heading-order";
  return {
    id: `soundness:${ruleId}`,
    ruleId,
    criterion: "test",
    kind: global ? "global" : "syntactic",
    route: global ? "human" : "codemod",
    source: item.source,
    routes: ["/"],
    violations: [item],
  };
}

function node(
  id: string,
  overrides: Partial<AccessibleNodeFact> = {},
): AccessibleNodeFact {
  return {
    id,
    role: "generic",
    name: "",
    text: "",
    interactive: false,
    ...overrides,
  };
}

function state(
  violations: Violation[],
  aria: AccessibleNodeFact[],
  probeFailures: string[] = [],
): PageVerificationState {
  return { violations, aria, probeFailures };
}

describe("verifier soundness harmful set", () => {
  it.each([
    {
      name: "deleting visible content",
      beforeAria: [node("content", { text: "Important content" })],
      afterAria: [],
      afterViolations: [],
      probes: [],
    },
    {
      name: "aria-hiding visible content",
      beforeAria: [node("content", { text: "Important content" })],
      afterAria: [],
      afterViolations: [],
      probes: [],
    },
    {
      name: "aria-hiding a focusable control",
      beforeAria: [node("button", { role: "button", name: "Save", interactive: true })],
      afterAria: [],
      afterViolations: [],
      probes: [],
    },
    {
      name: "display-none on content",
      beforeAria: [node("content", { text: "Important content" })],
      afterAria: [],
      afterViolations: [],
      probes: [],
    },
    {
      name: "removing the focus outline",
      beforeAria: [node("button", { role: "button", name: "Save", interactive: true })],
      afterAria: [node("button", { role: "button", name: "Save", interactive: true })],
      afterViolations: [],
      probes: ["focus-style"],
    },
    {
      name: "breaking hover contrast",
      beforeAria: [node("content", { text: "Readable" })],
      afterAria: [node("content", { text: "Readable" })],
      afterViolations: [],
      probes: ["interaction-contrast"],
    },
    {
      name: "empty alt on an informative image",
      beforeAria: [node("image", { role: "img", name: "Quarterly revenue chart" })],
      afterAria: [node("image", { role: "img", name: "" })],
      afterViolations: [],
      probes: [],
    },
  ])("rejects $name", ({ beforeAria, afterAria, afterViolations, probes }) => {
    const beforeViolation = violation("aria-valid-attr", "#target");
    const result = verifyPerPatch({
      task: task("aria-valid-attr"),
      before: state([beforeViolation], beforeAria),
      after: state(afterViolations, afterAria, probes),
    });
    expect(result.accepted).toBe(false);
  });

  it("rejects a patch that introduces an invalid ARIA-role violation", () => {
    const beforeViolation = violation("aria-valid-attr", "#target");
    const result = verifyPerPatch({
      task: task("aria-valid-attr"),
      before: state([beforeViolation], [node("target", { text: "Visible" })]),
      after: state(
        [violation("aria-roles", "#target", 8)],
        [node("target", { text: "Visible" })],
      ),
    });
    expect(result).toMatchObject({ accepted: false, check: "new-violation" });
  });
});

describe("verifier soundness legitimate-change set", () => {
  it("accepts removing a duplicate landmark role without removing its content", () => {
    const beforeViolation = violation("landmark-unique", "nav");
    const result = verifyPerPatch({
      task: { ...task("landmark-unique"), violations: [beforeViolation] },
      before: state(
        [beforeViolation],
        [node("nav", { role: "navigation", text: "Links" })],
      ),
      after: state([], [node("nav", { role: "generic", text: "Links" })]),
    });
    expect(result.accepted).toBe(true);
  });

  it("accepts a heading-level correction for heading-order", () => {
    const beforeViolation = violation("heading-order", "h4");
    const result = verifyPerPatch({
      task: { ...task("heading-order"), violations: [beforeViolation] },
      before: state(
        [beforeViolation],
        [node("heading", { role: "heading", text: "Title", headingLevel: 4 })],
      ),
      after: state(
        [],
        [node("heading", { role: "heading", text: "Title", headingLevel: 3 })],
      ),
    });
    expect(result.accepted).toBe(true);
  });

  it("accepts hiding a nameless textless decorative icon", () => {
    const beforeViolation = violation("aria-valid-attr", "#icon");
    const result = verifyPerPatch({
      task: task("aria-valid-attr"),
      before: state(
        [beforeViolation],
        [node("icon", { role: "img", name: "", text: "", interactive: false })],
      ),
      after: state([], []),
    });
    expect(result.accepted).toBe(true);
  });
});
