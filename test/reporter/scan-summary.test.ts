import { expect, it } from "vitest";
import { summarizeScans } from "../../src/reporter/scan-summary.js";
import { criterionReference } from "../../src/planner/references.js";
import { BrowserObservationSchema } from "../../src/scanner/observations.js";

const violation = { ruleId: "color-contrast", route: "/", condition: "desktop-light", target: ["#private-customer"], html: "private customer source", impact: "serious", failureSummary: null, source: { file: "app/page.tsx", line: 1, column: 1 } };
const before = BrowserObservationSchema.parse({ route: "/", condition: "desktop-light", violations: [violation], incomplete: [{ ...violation, ruleId: "image-alt" }], aria: [], ariaTree: "private rendered content", probeFailures: [], probeUnavailable: ["focus:private"], contexts: [], screenshot: "private.png", darkMediaDetected: false, sourceFiles: ["app/page.tsx"] });

it("pins technical references and never invents a clause for a newer or unknown criterion", () => {
  expect(criterionReference("1.4.3")).toMatchObject({ en301549: "9.1.4.3", edition: "EN 301 549 V3.2.1 (2021-03)" });
  expect(criterionReference("2.5.8").en301549).toBeNull();
  expect(criterionReference("unknown").en301549).toBeNull();
});
it("keeps inconclusive findings and exact observed scope without raw private page data", () => {
  const after = { ...before, violations: [] };
  const summary = summarizeScans([before], [after], [before]);
  expect(summary).toMatchObject({ routes: ["/"], conditions: ["desktop-light"], coverageComplete: true, sourceMapping: { mapped: 1, total: 1 }, probeUnavailable: 1 });
  expect(summary.rules).toContainEqual(expect.objectContaining({ ruleId: "color-contrast", before: 1, remaining: 0, en301549: "9.1.4.3" }));
  expect(summary.rules).toContainEqual(expect.objectContaining({ ruleId: "image-alt", incomplete: 1 }));
  expect(JSON.stringify(summary)).not.toContain("private");
});
it("marks a missing route or condition as incomplete coverage rather than a clean scan", () => {
  const summary = summarizeScans([before], [], [before]);
  expect(summary.coverageComplete).toBe(false);
  expect(summary.missingObservations).toEqual(["/|desktop-light"]);
});
it("retains actual additional checker versions without exporting its private report", () => {
  const page = { ...before, checkerVersion: "4.13.0", ibmCheckerVersion: "4.0.34" };
  expect(summarizeScans([page], [page], [page]).checkerVersions).toEqual(["4.13.0", "ibm-equal-access@4.0.34"]);
});
