import { describe, expect, it } from "vitest";

import { normalizeAxeResults } from "../../src/scanner/scan.js";

describe("normalizeAxeResults", () => {
  it("emits one record per axe node with source mapping", () => {
    const result = normalizeAxeResults("/", {
      violations: [
        {
          id: "button-name",
          impact: "critical",
          tags: ["wcag2a"],
          description: "Buttons must have discernible text",
          help: "Buttons must have discernible text",
          helpUrl: "https://dequeuniversity.com/rules/axe/button-name",
          nodes: [
            {
              target: ["button"],
              html: '<button data-insp-path="app/page.tsx" data-insp-row="7" data-insp-col="7"></button>',
              failureSummary: "Fix the button",
            },
            {
              target: ["#second"],
              html: "<button></button>",
              failureSummary: "Fix the button",
            },
          ],
        },
      ],
      incomplete: [],
    });

    expect(result.violations).toEqual([
      {
        ruleId: "button-name",
        impact: "critical",
        route: "/",
        target: ["button"],
        html: '<button data-insp-path="app/page.tsx" data-insp-row="7" data-insp-col="7"></button>',
        failureSummary: "Fix the button",
        source: { file: "app/page.tsx", line: 7, column: 7 },
      },
      {
        ruleId: "button-name",
        impact: "critical",
        route: "/",
        target: ["#second"],
        html: "<button></button>",
        failureSummary: "Fix the button",
        source: null,
      },
    ]);
  });

  it("keeps incomplete nodes separate from violations", () => {
    const result = normalizeAxeResults("/contrast", {
      violations: [],
      incomplete: [
        {
          id: "color-contrast",
          impact: "serious",
          tags: [],
          description: "contrast",
          help: "contrast",
          helpUrl: "https://example.invalid",
          nodes: [
            {
              target: [".hero"],
              html: '<p class="hero">Text</p>',
              failureSummary: null,
            },
          ],
        },
      ],
    });

    expect(result.violations).toEqual([]);
    expect(result.incomplete).toHaveLength(1);
    expect(result.incomplete[0]?.ruleId).toBe("color-contrast");
    expect(result.incomplete[0]?.source).toBeNull();
  });

  it("rejects malformed axe boundary data", () => {
    expect(() =>
      normalizeAxeResults("/", {
        violations: [{ id: "bad", nodes: "not-an-array" }],
        incomplete: [],
      }),
    ).toThrow();
  });
});
