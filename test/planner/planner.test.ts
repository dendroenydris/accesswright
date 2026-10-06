import { describe, expect, it } from "vitest";

import { planFixTasks } from "../../src/planner/planner.js";
import { getRuleDefinition } from "../../src/planner/rules.js";
import type { Violation } from "../../src/types/schemas.js";

function violation(overrides: Partial<Violation> = {}): Violation {
  return {
    ruleId: "aria-valid-attr",
    impact: "critical",
    route: "/",
    target: ["div"],
    html: '<div aria-bogus="x"></div>',
    failureSummary: "invalid aria",
    source: { file: "app/page.tsx", line: 8, column: 7 },
    ...overrides,
  };
}

describe("rule table", () => {
  it.each([
    ["aria-valid-attr", "codemod"],
    ["tabindex", "codemod"],
    ["color-contrast", "optimizer"],
    ["image-alt", "llm"],
    ["button-name", "llm"],
    ["link-name", "llm"],
  ] as const)("routes %s to %s", (ruleId, route) => {
    expect(getRuleDefinition(ruleId).route).toBe(route);
  });

  it("routes unsupported rules to human", () => {
    expect(getRuleDefinition("unknown-rule").route).toBe("human");
  });
});

describe("planFixTasks", () => {
  it("deduplicates repeated instances from the same source site and criterion", () => {
    const tasks = planFixTasks([
      violation({ route: "/a" }),
      violation({ route: "/b", target: ["#other-instance"] }),
    ]);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      ruleId: "aria-valid-attr",
      route: "codemod",
      routes: ["/a", "/b"],
    });
    expect(tasks[0]?.violations).toHaveLength(2);
  });

  it("keeps different source sites separate", () => {
    const tasks = planFixTasks([
      violation(),
      violation({ source: { file: "app/page.tsx", line: 12, column: 7 } }),
    ]);

    expect(tasks).toHaveLength(2);
  });

  it("routes unmapped violations to human", () => {
    const tasks = planFixTasks([violation({ source: null })]);

    expect(tasks[0]).toMatchObject({ route: "human", source: null });
  });

  it("turns semantic work into human handoff in no-LLM mode", () => {
    const tasks = planFixTasks(
      [violation({ ruleId: "image-alt", impact: "serious" })],
      { noLlm: true },
    );

    expect(tasks[0]).toMatchObject({ kind: "semantic", route: "human" });
  });

  it("routes contrast to the deterministic optimizer", () => {
    const tasks = planFixTasks([
      violation({ ruleId: "color-contrast", impact: "serious" }),
    ]);

    expect(tasks[0]).toMatchObject({ kind: "layout", route: "optimizer" });
  });

  it("orders higher-impact work first and remains stable", () => {
    const tasks = planFixTasks([
      violation({
        ruleId: "color-contrast",
        impact: "serious",
        source: { file: "app/page.tsx", line: 20, column: 1 },
      }),
      violation({
        ruleId: "aria-valid-attr",
        impact: "critical",
        source: { file: "app/page.tsx", line: 8, column: 1 },
      }),
    ]);

    expect(tasks.map((task) => task.ruleId)).toEqual([
      "aria-valid-attr",
      "color-contrast",
    ]);
  });
});
