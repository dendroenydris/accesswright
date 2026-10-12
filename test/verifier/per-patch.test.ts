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

  it("rejects a pre-existing unstable interactive node rather than silently treating it as probed", () => {
    const unstable = "unstable-interactive:/|desktop-light|dom/0/1";
    expect(verifyPerPatch({
      task: task(),
      before: state([violation()], [node()], [unstable]),
      after: state([], [node()], [unstable]),
    })).toMatchObject({ accepted: false, check: "probe" });
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

describe("volatile baseline identities and text (mk965 rmiz ids, clocks, typing animations)", () => {
  const zoom = (token: string) => violation("aria-valid-attr-value", `div[aria-owns="rmiz-modal-${token}"]`);
  const contrast = task("color-contrast");

  it("does not treat a fresh random id on reload as a new violation", () => {
    expect(verifyPerPatch({ task: contrast, before: state([violation("color-contrast", "#target"), zoom("45a54583162e")]), after: state([zoom("5d854068c5c8")]) }))
      .toEqual({ accepted: true, check: "ok", reason: null });
  });

  it("still rejects one extra violation on another element with the same masked selector", () => {
    expect(verifyPerPatch({ task: contrast, before: state([violation("color-contrast", "#target"), zoom("45a54583162e")]), after: state([zoom("5d854068c5c8"), zoom("e658c765a188")]) }))
      .toMatchObject({ accepted: false, check: "new-violation" });
  });

  it("does not count a target as fixed when it only received a new random id", () => {
    const target = zoom("45a54583162e");
    const fix: FixTask = { ...task("aria-valid-attr-value"), violations: [target] };
    expect(verifyPerPatch({ task: fix, before: state([target]), after: state([zoom("5d854068c5c8")]) }))
      .toMatchObject({ accepted: false, check: "target" });
  });

  it("accepts fixing one of several elements that share a masked selector, and rejects fixing none", () => {
    const first = zoom("45a54583162e"), second = zoom("1818daa8ccb8");
    const fix: FixTask = { ...task("aria-valid-attr-value"), violations: [first] };
    expect(verifyPerPatch({ task: fix, before: state([first, second]), after: state([zoom("d4984d4c2828")]) })).toMatchObject({ accepted: true });
    expect(verifyPerPatch({ task: fix, before: state([first, second]), after: state([zoom("d4984d4c2828"), zoom("e658c765a188")]) }))
      .toMatchObject({ accepted: false, check: "target" });
  });

  it("ignores digit-only text changes such as clocks", () => {
    expect(verifyPerPatch({ task: task(), before: state([violation()], [node({ text: "10:48 AM" })]), after: state([], [node({ text: "10:52 AM" })]) }))
      .toMatchObject({ accepted: true });
  });

  it("still rejects removed or replaced words, and emptied text even on volatile nodes", () => {
    expect(verifyPerPatch({ task: task(), before: state([violation()], [node({ text: "Delete account" })]), after: state([], [node({ text: "Delete" })]) }))
      .toMatchObject({ accepted: false, check: "aria-tree" });
    expect(verifyPerPatch({ task: task(), before: state([violation()], [node({ text: "I'm ali", volatileText: true })]), after: state([], [node({ text: "" })]) }))
      .toMatchObject({ accepted: false, check: "aria-tree" });
  });

  it("skips text equality only for nodes learned as volatile from unpatched baselines", () => {
    expect(verifyPerPatch({ task: task(), before: state([violation()], [node({ text: "I'm ali", volatileText: true })]), after: state([], [node({ text: "I'm alia" })]) }))
      .toMatchObject({ accepted: true });
    expect(verifyPerPatch({ task: task(), before: state([violation()], [node({ text: "I'm ali" })]), after: state([], [node({ text: "I'm alia" })]) }))
      .toMatchObject({ accepted: false, check: "aria-tree" });
  });
});
