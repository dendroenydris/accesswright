import { expect, it } from "vitest";
import { EvalCellSchema, aggregateEvaluation, renderEvaluationReport } from "../../src/eval/report.js";
import { BrowserObservationSchema } from "../../src/scanner/observations.js";
import { compareCleanControls } from "../../src/eval/controls.js";

const base = { schemaVersion: 1, protocolDigest: "a".repeat(64), implementationDigest: "b".repeat(64), repository: "owner/repo", sha: "c".repeat(40), corpus: "public-nextjs", split: "test", seed: 1, batch: 0, system: "A", providerMode: "live", providerEvidence: "provider-api", model: { provider: "openai", id: "fixture-model", reasoningEffort: "high" }, startedAt: "2026-10-07T00:00:00.000Z", finishedAt: "2026-10-07T00:00:01.000Z", durationMs: 1000, status: "completed", reason: null, cases: [{ id: "d".repeat(64), operator: "remove-alt", checkerAccepted: true, semanticallyCorrect: false, correctlyFixed: false }], exclusions: [], verification: [], usage: { spentUsd: 0.001, inputTokens: 100, outputTokens: 10, unknownUsage: false }, controls: { observed: 10, changed: 0, unexpectedEditedFiles: [] }, newViolations: 0, report: null };

it("keeps checker-only acceptance separate from semantic success and does not manufacture a rate for blocked cells", () => {
  const cell = EvalCellSchema.parse(base);
  const blocked = EvalCellSchema.parse({ ...base, batch: 1, status: "blocked", reason: "budget", cases: [] });
  const report = aggregateEvaluation([cell, blocked]);
  expect(report.groups[0]).toMatchObject({ eligibleCases: 1, checkerAccepted: 1, correctlyFixed: 0, falseFixes: 1, correctFixRate: 0, completedCells: 1, blockedCells: 1 });
  const empty = aggregateEvaluation([blocked]);
  expect(empty.groups[0]?.correctFixRate).toBeNull();
  expect(renderEvaluationReport(report)).toContain("not a complete benchmark");
});

it("rejects duplicate case/seed observations and never pools fake providers with live measurements", () => {
  const cell = EvalCellSchema.parse(base);
  expect(() => aggregateEvaluation([cell, cell])).toThrow(/duplicate/i);
  const fake = EvalCellSchema.parse({ ...base, batch: 2, providerMode: "fake", providerEvidence: "fake-provider", cases: [{ ...base.cases[0], id: "e".repeat(64) }] });
  expect(aggregateEvaluation([cell, fake]).groups).toHaveLength(2);
  expect(() => EvalCellSchema.parse({ ...base, cases: [{ ...base.cases[0], correctlyFixed: true }] })).toThrow();
});

it("retains no-call deterministic fixes in the denominator of the same configured comparison", () => {
  const called = EvalCellSchema.parse(base);
  const free = EvalCellSchema.parse({ ...base, batch: 1, providerEvidence: "not-run", cases: [{ ...base.cases[0], id: "f".repeat(64) }], usage: { spentUsd: 0, inputTokens: 0, outputTokens: 0, unknownUsage: false } });
  const report = aggregateEvaluation([called, free]);
  expect(report.groups).toHaveLength(1);
  expect(report.groups[0]?.eligibleCases).toBe(2);
});

it("reports matched B1/A1/A denominators separately from unpaired coverage and retains failed repairs", () => {
  const cells = ["B1", "A1", "A"].map(system => EvalCellSchema.parse({ ...base, system }));
  cells[0]?.cases.push({ id: "e".repeat(64), operator: "invalid-aria", checkerAccepted: true, semanticallyCorrect: true, correctlyFixed: true });
  const report = aggregateEvaluation(cells);
  expect(report.pairedComparisons[0]).toMatchObject({ pairedCaseOpportunities: 1, systems: ["B1", "A1", "A"] });
  expect(report.pairedComparisons[0]?.results.map(result => result.eligibleCases)).toEqual([1,1,1]);
  expect(report.pairedComparisons[0]?.results[0]?.unpairedCaseOpportunities).toBe(1);
});

it("rejects transport provenance inconsistent with the configured evaluation mode", () => {
  expect(() => EvalCellSchema.parse({ ...base, providerMode: "fake" })).toThrow();
  expect(() => aggregateEvaluation([base, { ...base, system: "B1", model: { provider: "openai", id: "another" } }])).toThrow(/model/i);
});

it("checks unaffected rendered nodes instead of equating a patched file with a clean control", () => {
  const page = BrowserObservationSchema.parse({ route: "/", condition: "desktop-light", violations: [], incomplete: [], aria: [{ id: "clean", role: "button", name: "Cancel", text: "Cancel", interactive: true }], ariaTree: "", contexts: [], sourceFiles: [], probeFailures: [], probeUnavailable: [], screenshot: "page.png", darkMediaDetected: false });
  expect(compareCleanControls([page], [page], [], [], new Set())).toMatchObject({ observed: 1, changed: 0 });
  expect(compareCleanControls([page], [{ ...page, aria: [] }], [], [], new Set())).toMatchObject({ observed: 1, changed: 1 });
  expect(compareCleanControls([page], [page], [], ["Other.tsx"], new Set(["Target.tsx"])).unexpectedEditedFiles).toEqual(["Other.tsx"]);
});
