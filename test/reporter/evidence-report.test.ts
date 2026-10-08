import { expect, it } from "vitest";

import { renderEvidenceReport } from "../../src/reporter/evidence-report.js";
import type { RunReport } from "../../src/reporter/report.js";

const report: RunReport = {
  schemaVersion: 1,
  startedAt: "2026-10-07T00:00:00.000Z",
  finishedAt: "2026-10-07T00:00:10.000Z",
  durationMs: 10_000,
  status: "verified",
  applied: false,
  fixed: 1,
  rejected: 1,
  needsHuman: 2,
  ignored: 0,
  attempts: 2,
  providerVerification: "provider-api",
  unknownUsage: false,
  usage: { inputTokens: 100, outputTokens: 20, spentUsd: 0.0001 },
  checks: [
    { check: "build", available: true, status: "passed", durationMs: 1, exitCode: 0, failureIds: [] },
    { check: "typecheck", available: true, status: "passed", durationMs: 1, exitCode: 0, failureIds: [] },
    { check: "lint", available: true, status: "passed", durationMs: 1, exitCode: 0, failureIds: [] },
    { check: "tests", available: false, status: "unavailable", durationMs: 0, exitCode: null, failureIds: [] },
  ],
  outcomes: [
    { id: "accepted", ruleId: "button-name", criterion: "4.1.2", route: "llm", status: "verified", reason: null },
    { id: "review", ruleId: "image-alt", criterion: "1.1.1", route: "llm", status: "needs-human", reason: "semantic-repair-unresolved" },
  ],
  final: { acceptedFixIds: ["accepted"], droppedFixIds: [], failures: [] },
  scanSummary: {
    countUnit: "finding per route and scan condition",
    routes: ["/", "/help"],
    conditions: ["desktop-light", "mobile-light"],
    checkerVersions: ["4.10.3"],
    coverageComplete: true,
    missingObservations: [],
    sourceMapping: { mapped: 3, total: 4 },
    probeUnavailable: 1,
    rules: [
      { ruleId: "button-name", criterion: "4.1.2", en301549: "9.4.1.2", before: 1, remaining: 0, incomplete: 0 },
      { ruleId: "color-contrast", criterion: "1.4.3", en301549: "9.1.4.3", before: 2, remaining: 1, incomplete: 1 },
    ],
  },
};

it("renders an aggregate P1 evidence report without private source content", () => {
  const text = renderEvidenceReport(report, {
    commits: [{ id: "accepted", commit: "a".repeat(40) }],
  });
  expect(text).toContain("# Accesswright evidence report");
  expect(text).toContain("Found / fixed / remaining");
  expect(text).toContain("4.1.2");
  expect(text).toContain("9.4.1.2");
  expect(text).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  expect(text).toContain("Needs review");
  expect(text).toContain("semantic-repair-unresolved");
  expect(text).toContain("Inconclusive checker findings: 1");
  expect(text).toContain("Not automatically testable");
  expect(text).toContain("manual");
  expect(text).toContain("Routes: /, /help");
  expect(text).toContain("Conditions: desktop-light, mobile-light");
  expect(text).toContain("axe-core: 4.10.3");
  expect(text).toContain("tests: unavailable");
  expect(text).toContain("not a legal compliance certification");
  expect(text).not.toContain("private before");
  expect(text).not.toContain("private after");
});

it("fails closed when accepted fix IDs and supplied commit evidence disagree", () => {
  expect(() => renderEvidenceReport(report, { commits: [] })).toThrow(/commit/i);
});
