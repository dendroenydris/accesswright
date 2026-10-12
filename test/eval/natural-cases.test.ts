import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { defaults } from "../../src/config.js";
import { collectNaturalCases, naturalScanMetadata, runNaturalCasesCli } from "../../src/eval/natural-cases.js";
import type { BrowserObservation } from "../../src/scanner/observations.js";

const scope = { schemaVersion: 1, protocolDigest: "a".repeat(64), repositoryDigest: "b".repeat(64),
  baseSha: "c".repeat(40), implementationDigest: "d".repeat(64), observedAt: "2026-10-12T00:00:00.000Z", checkerVersion: "4.13.0" };
const finding = { ruleId: "button-name", impact: "serious", targetDigest: "e".repeat(64), sourceDigest: null };
const page = { routeDigest: "f".repeat(64), condition: "desktop-light", violations: [finding], incompleteCount: 2 };
const scan = { ...scope, pages: [page] };

it("collects pinned natural instances and blank audit rows without counting incomplete results", () => {
  const result = collectNaturalCases(scan);
  expect(result).toMatchObject({ track: "N", provenance: "supplied-baseline-metadata", baseSha: scope.baseSha,
    observedPages: 1, incompleteFindings: 2, labelingSheet: { targetAcceptedPatches: 50, plannedRaters: 1 } });
  expect(result.cases).toHaveLength(1);
  expect(result.cases[0]).toMatchObject({ ruleId: "button-name", criterion: "4.1.2", en301549: "9.4.1.2", repairRoute: "llm" });
  expect(result.labelingSheet.rows[0]).toEqual({ caseId: result.cases[0]?.caseId, patchDigest: null, reviewerDigest: null,
    reviewedAt: null, verifierEvidenceDigest: null, targetResolved: null, noNewViolations: null, contentPreserved: null,
    semanticCorrect: null, keyboardChecked: null, screenReaderSpotChecked: null });
  expect(collectNaturalCases({ ...scope, pages: [] })).toMatchObject({ observedPages: 0, cases: [], labelingSheet: { rows: [] } });
});

it("keeps identical-location occurrences distinct and identities stable across enumeration order", () => {
  const input = { ...scope, pages: [{ ...page, violations: [finding, finding, { ...finding, ruleId: "image-alt" }] },
    { ...page, condition: "mobile-light" }] };
  const original = collectNaturalCases(input);
  expect(original.cases).toHaveLength(4);
  expect(new Set(original.cases.map(item => item.caseId)).size).toBe(4);
  expect(original.cases.filter(item => item.condition === "desktop-light" && item.ruleId === "button-name").map(item => item.occurrence)).toEqual([0, 1]);
  expect(collectNaturalCases({ ...input, pages: [...input.pages].reverse().map(item => ({ ...item, violations: [...item.violations].reverse() })) }).cases).toEqual(original.cases);
  expect(collectNaturalCases({ ...input, baseSha: "0".repeat(40) }).cases.map(item => item.caseId)).not.toEqual(original.cases.map(item => item.caseId));
  expect(collectNaturalCases({ ...input, repositoryDigest: "0".repeat(64) }).cases.map(item => item.caseId)).not.toEqual(original.cases.map(item => item.caseId));
  expect(collectNaturalCases({ ...input, implementationDigest: "0".repeat(64) }).scanDigest).not.toBe(original.scanDigest);
});

it("rejects repeat scans and retains unmapped/manual rules without inventing standards references", () => {
  expect(() => collectNaturalCases({ ...scope, pages: [page, page] })).toThrow(/Repeated/);
  const result = collectNaturalCases({ ...scope, pages: [{ ...page, violations: [{ ...finding, ruleId: "custom-rule" }, { ...finding, ruleId: "target-size" }] }] });
  expect(result.cases.find(item => item.ruleId === "custom-rule")).toMatchObject({ criterion: null, en301549: null, repairRoute: "human" });
  expect(result.cases.find(item => item.ruleId === "target-size")).toMatchObject({ criterion: "2.5.8", en301549: null, repairRoute: "human" });
});

it("projects real observation shapes in memory and excludes private rendered/source facts", () => {
  const violation = { ruleId: "button-name", impact: "serious", route: "/private-route", target: ["#private-target"], html: "<button>private html</button>",
    failureSummary: "private summary", source: { file: "private-component.tsx", line: 2, column: 3 } };
  const observation: BrowserObservation = { route: violation.route, condition: "desktop-light", checkerVersion: scope.checkerVersion,
    violations: [violation, { ...violation, target: ["#other"] }], incomplete: [violation], aria: [], ariaTree: "private tree",
    documentTitle: "private title", probeFailures: [], probeUnavailable: [], contexts: [], screenshot: "private-image.png", darkMediaDetected: false,
    sourceFiles: ["private-file.tsx"] };
  const before = JSON.stringify(observation);
  const result = naturalScanMetadata(scope, [observation]);
  expect(result.pages[0]?.violations).toHaveLength(2);
  expect(result.pages[0]?.violations[0]?.targetDigest).not.toBe(result.pages[0]?.violations[1]?.targetDigest);
  expect(JSON.stringify(result)).not.toContain("private");
  const output = JSON.stringify(collectNaturalCases(result));
  for (const value of ["private-route", "private-target", "private html", "private summary", "private-component.tsx", "private tree", "private title", "private-image.png", "private-file.tsx"]) expect(output).not.toContain(value);
  expect(JSON.stringify(observation)).toBe(before);
  expect(() => naturalScanMetadata(scope, [{ ...observation, checkerVersion: "other" }])).toThrow(/Conflicting/);
  expect(() => naturalScanMetadata(scope, [{ ...observation, violations: [{ ...violation, route: "/other" }] }])).toThrow(/Conflicting/);
  expect(() => naturalScanMetadata(scope, [{ ...observation, violations: [{ ...violation, condition: "mobile-light" }] }])).toThrow(/Conflicting/);
});

it.each([
  { baseSha: "main" }, { protocolDigest: "invalid" }, { observedAt: "yesterday" }, { source: "private" },
  { pages: [{ ...page, route: "/private" }] }, { pages: [{ ...page, violations: [{ ...finding, html: "private" }] }] },
  { pages: [{ ...page, violations: [{ ...finding, impact: "private" }] }] }, { pages: [{ ...page, incompleteCount: -1 }] },
])("rejects malformed or private scan fields %j", extra => { expect(() => collectNaturalCases({ ...scan, ...extra })).toThrow(); });

it("bounds aggregate findings across pages, even when each page is individually within its limit", () => {
  const many = Array.from({ length: defaults.naturalCasesMaxFindings / 2 + 1 }, () => finding);
  expect(() => collectNaturalCases({ ...scope, pages: [{ ...page, violations: many }, { ...page, condition: "mobile-light", violations: many }] })).toThrow(/Too many/);
});

it("reads metadata offline without changing inputs and refuses unsafe files and arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-natural-cases-"));
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No model/cloud/browser calls"));
  try {
    const path = join(root, "scan.json"), alias = join(root, "alias.json"), raw = JSON.stringify(scan);
    await writeFile(path, raw);
    expect((await runNaturalCasesCli(["--scan", path])).cases).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe(raw);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(runNaturalCasesCli([])).rejects.toThrow(/Expected/);
    await expect(runNaturalCasesCli(["--scan", "relative"])).rejects.toThrow(/absolute/);
    await expect(runNaturalCasesCli(["--scan", path, "--scan", path])).rejects.toThrow(/Expected/);
    await expect(runNaturalCasesCli(["--scan", root])).rejects.toThrow(/regular/);
    await symlink(path, alias);
    await expect(runNaturalCasesCli(["--scan", alias])).rejects.toThrow();
    await writeFile(path, " ".repeat(defaults.naturalCasesInputMaxBytes + 1));
    await expect(runNaturalCasesCli(["--scan", path])).rejects.toThrow(/bounded/);
    await writeFile(path, "{invalid-json");
    await expect(runNaturalCasesCli(["--scan", path])).rejects.toThrow();
  } finally { fetcher.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
