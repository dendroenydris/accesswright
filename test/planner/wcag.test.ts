import { describe, expect, it } from "vitest";
import { en301549Clause, wcagCriterion } from "../../src/planner/wcag.js";

describe("WCAG criteria", () => {
  it("names criteria and maps WCAG 2.1 A/AA to EN 301 549 clause 9", () => {
    expect(wcagCriterion("1.4.3")).toEqual({ sc: "1.4.3", name: "Contrast (Minimum)", level: "AA", since: "2.0" });
    expect(en301549Clause("1.4.3")).toBe("9.1.4.3");
    expect(en301549Clause("1.3.5")).toBe("9.1.3.5");
  });

  it("leaves WCAG 2.2 additions, AAA and unknown criteria unmapped", () => {
    expect(en301549Clause("2.5.8")).toBeNull();
    expect(en301549Clause("1.4.6")).toBeNull();
    expect(en301549Clause("unknown")).toBeNull();
    expect(wcagCriterion("9.9.9")).toBeNull();
  });
});
