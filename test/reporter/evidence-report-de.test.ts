import { expect, it } from "vitest";

import { renderGermanEvidenceReport } from "../../src/reporter/evidence-report-de.js";
import type { RunReport } from "../../src/reporter/report.js";

const report: RunReport = {
  schemaVersion: 1,
  startedAt: "2026-10-08T07:00:00.000Z",
  finishedAt: "2026-10-08T07:01:00.000Z",
  durationMs: 60000, status: "blocked", applied: false,
  fixed: 1, rejected: 1, needsHuman: 1, ignored: 0, attempts: 2,
  providerVerification: "not-run", unknownUsage: true,
  usage: { inputTokens: 100, outputTokens: 30, spentUsd: 0.0001 },
  checks: [
    { check: "build", available: true, status: "passed", durationMs: 1, exitCode: 0, failureIds: [] },
    { check: "typecheck", available: true, status: "passed", durationMs: 1, exitCode: 0, failureIds: [] },
    { check: "lint", available: true, status: "passed", durationMs: 1, exitCode: 0, failureIds: [] },
    { check: "tests", available: false, status: "unavailable", durationMs: 0, exitCode: null, failureIds: [] },
  ],
  outcomes: [
    { id: "fix-1", ruleId: "button-name", criterion: "4.1.2", route: "llm", status: "verified", reason: null },
    { id: "human-1", ruleId: "image-alt", criterion: "1.1.1", route: "human", status: "needs-human", reason: "<private-source> -- requires review" },
  ],
  final: { acceptedFixIds: ["fix-1"], droppedFixIds: [], failures: [{ check: "tests", id: "missing" }] },
  scanSummary: {
    countUnit: "finding per route and scan condition",
    routes: ["/", "/help"],
    conditions: ["desktop-light", "mobile-light"],
    checkerVersions: ["4.13.0"],
    coverageComplete: true, missingObservations: [],
    sourceMapping: { mapped: 3, total: 4 }, probeUnavailable: 2,
    rules: [
      { ruleId: "button-name", criterion: "4.1.2", en301549: "9.4.1.2", before: 2, remaining: 1, incomplete: 0 },
      { ruleId: "color-contrast", criterion: "1.4.3", en301549: "9.1.4.3", before: 3, remaining: 3, incomplete: 1 },
    ],
  },
};

it("generates a technically correct German evidence template without claiming legal conformity", () => {
  const text = renderGermanEvidenceReport(report, { commits: [{ id: "fix-1", commit: "a".repeat(40) }] });
  expect(text).toContain("# Technischer Barrierefreiheits-Prüfbericht");
  expect(text).toContain("kein Konformitätsnachweis");
  expect(text).toContain("Manuelle Prüfung");
  expect(text).toContain("9.4.1.2");
  expect(text).toContain("1.4.3");
  expect(text).toContain("Tests: nicht verfügbar");
  expect(text).toContain("nicht abgeglichen");
  expect(text).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  expect(text).toContain("Tastatur");
  expect(text).toContain("Screenreader");
  expect(text).toContain("Quelle");
  expect(text).not.toContain("<private-source>");
});

it("refuses missing or contradictory commit evidence", () => {
  expect(() => renderGermanEvidenceReport(report, { commits: [] })).toThrow(/commit|Übereinstimm/i);
  expect(() => renderGermanEvidenceReport(report, { commits: [{ id: "wrong", commit: "a".repeat(40) }] })).toThrow();
  expect(() => renderGermanEvidenceReport(report, { commits: [{ id: "fix-1", commit: "invalid" }] })).toThrow();
});

it("marks missing scan coverage as unmeasured rather than claiming zero findings", () => {
  const text = renderGermanEvidenceReport({ ...report, scanSummary: undefined }, {
    commits: [{ id: "fix-1", commit: "b".repeat(40) }],
  });
  expect(text).toContain("nicht erfasst");
  expect(text).not.toContain("vollständige Abdeckung");
});
