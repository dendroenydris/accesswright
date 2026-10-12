import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, expect, it, vi } from "vitest";

import { verifyHostedCandidate } from "../../src/hosted/trusted-verifier.js";
import { hostedReportDigest } from "../../src/hosted/run-workflow.js";
import { hostedCandidateDigest } from "../../src/hosted/agent-protocol.js";
import { hostedVerifiedArtifactDigest } from "../../src/hosted/verified-publication.js";
import type { RepairRuntime } from "../../src/core/repair.js";
import { planFixTasks } from "../../src/planner/planner.js";
import type { RunReport } from "../../src/reporter/report.js";
import type { RepairSessionOptions } from "../../src/runner/repair-session.js";
import type { ProductionCheckResult } from "../../src/runner/production-checks.js";
import { BrowserObservationSchema } from "../../src/scanner/observations.js";
import type { BrowserObservation } from "../../src/scanner/observations.js";
import { AccesswrightConfigSchema } from "../../src/types/schemas.js";
import type { Patch, Violation } from "../../src/types/schemas.js";

const source = 'export const Button = () => <button id="save" aria-bogus="bad">Save</button>;\n';
const location = { file: "Button.tsx", line: 1, column: 29 };
const violation: Violation = { ruleId: "aria-valid-attr", route: "/", impact: "serious", target: ["#save"], html: '<button aria-bogus="bad">Save</button>', failureSummary: null, source: location };
const task = planFixTasks([violation])[0];
const roots: string[] = [];
function observation(violations: Violation[], hidden = false): BrowserObservation {
  return BrowserObservationSchema.parse({ route: "/", condition: "desktop-light", violations, incomplete: [],
    aria: hidden ? [] : [{ id: "save", role: "button", name: "Save", text: "Save", interactive: true }],
    ariaTree: "- button Save", probeFailures: [], probeUnavailable: [], contexts: [], screenshot: "page.png", darkMediaDetected: false });
}

class Runtime implements RepairRuntime {
  config = AccesswrightConfigSchema.parse({});
  observations = [observation([violation])];
  baselineObservations = [observation([violation])];
  productionBaseline = [observation([violation])];
  finalObservations = [observation([])];
  finalChecks: ProductionCheckResult[] = ["build", "typecheck", "lint", "tests"].map(check => ({
    check: check as ProductionCheckResult["check"], argv: [], available: true, status: "passed", exitCode: 0, durationMs: 1, failureIds: [],
  }));
  source = source;
  patches: Patch[] = [];
  journal = { exportPatches: vi.fn((ids: readonly string[]) => Promise.resolve(this.patches.filter(patch => ids.includes(patch.taskId)).map(patch => ({
    taskId: patch.taskId, changes: patch.changes.map(change => ({ ...change, before: source, after: this.source })),
  })))) };
  closed = false;
  onFinal: (() => Promise<void>) | undefined;
  evidenceDir: string;
  constructor(evidenceDir: string) { this.evidenceDir = evidenceDir; }
  readSource() { return Promise.resolve(this.source); }
  applyPatch(patch: Patch) { const change = patch.changes[0]; this.source = this.source.replace(change.before, change.after); return Promise.resolve(patch); }
  revertPatch() { this.source = source; return Promise.resolve(); }
  scan() { return Promise.resolve([observation(this.source === source ? [violation] : [], this.source.includes("hidden"))]); }
  affectedRoutes() { return ["/"]; }
  updateObservations(after: BrowserObservation[]) { this.observations = after; }
  record(patch: Patch) { this.patches.push(patch); return Promise.resolve(); }
  async verifyFinal() { await this.onFinal?.(); return { acceptedFixIds: this.patches.map(patch => patch.taskId), droppedFixIds: [], failures: [] }; }
  finalPatch() { return Promise.resolve(this.patches[0] ?? null); }
  close() { this.closed = true; return Promise.resolve(); }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aw-trusted-verification-"));
  roots.push(root);
  const repoPath = join(root, "repo");
  await mkdir(repoPath);
  const git = async (args: string[]) => (await execa("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", ...args], { cwd: repoPath })).stdout.trim();
  await git(["init"]);
  await writeFile(join(repoPath, location.file), source);
  await git(["add", "--", location.file]);
  await git(["commit", "-m", "fixture"]);
  const verifiedBaseSha = await git(["rev-parse", "HEAD"]);
  const runtime = new Runtime(join(root, "evidence"));
  const report: RunReport = {
    schemaVersion: 1, startedAt: "2026-10-11T01:00:00.000Z", finishedAt: "2026-10-11T01:01:00.000Z",
    durationMs: 60000, status: "verified", applied: false, fixed: 1, rejected: 0, needsHuman: 0, ignored: 0, attempts: 1,
    providerVerification: "not-run", unknownUsage: false, usage: { inputTokens: 0, outputTokens: 0, spentUsd: 0 },
    checks: runtime.finalChecks.map(({ check, available, status, exitCode, durationMs, failureIds }) => ({ check, available, status, exitCode, durationMs, failureIds })),
    outcomes: [{ id: task.id, ruleId: task.ruleId, criterion: task.criterion, route: task.route, status: "verified", reason: null }],
    final: { acceptedFixIds: [task.id], droppedFixIds: [], failures: [] },
  };
  const prepare = vi.fn(async (options: RepairSessionOptions) => {
    expect(await readFile(join(options.repoPath, location.file), "utf8")).toBe(source);
    expect(options).toMatchObject({ retainEvidence: false, privateDiagnostics: false });
    await mkdir(runtime.evidenceDir);
    return runtime;
  });
  const options = { repoPath, verifiedBaseSha, tempRoot: join(root, "runs"), runtimeRoot: root,
    reconciled: { usage: { ...report.usage }, unknownUsage: false, providerVerification: report.providerVerification } };
  const input = { report, patches: [{ taskId: task.id, changes: [{ path: location.file, before: source, after: source.replace(' aria-bogus="bad"', "") }] }] };
  return { root, runtime, prepare, options, input };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("produces a digest-bound receipt only after independent patch and production checks", async () => {
  const f = await fixture();
  const verified = await verifyHostedCandidate(f.options, f.input, { prepare: f.prepare });
  expect(verified?.receipt).toEqual({ reportDigest: hostedReportDigest(f.input.report), verifiedBaseSha: f.options.verifiedBaseSha });
  expect(verified?.artifact).toMatchObject({ candidateDigest: hostedCandidateDigest(f.input), workerReportDigest: hostedReportDigest(f.input.report),
    verifiedBaseSha: f.options.verifiedBaseSha, patches: f.input.patches, report: { fixed: 1, status: "verified", applied: false, scanSummary: { coverageComplete: true } } });
  expect(f.runtime.closed).toBe(true);
  expect(await readFile(join(f.options.repoPath, location.file), "utf8")).toBe(source);
  expect(await readdir(f.options.tempRoot)).toEqual([]);
  expect(await readFile(join(f.runtime.evidenceDir, "run.jsonl"), "utf8")).toContain('"step":"trusted-verification","status":"ok"');
});

it("rejects a worker's claimed success when independent browser facts show hidden content", async () => {
  const f = await fixture();
  f.input.patches[0].changes[0].after = source.replace(' aria-bogus="bad"', " hidden");
  expect(await verifyHostedCandidate(f.options, f.input, { prepare: f.prepare })).toBeNull();
  expect(f.runtime.patches).toEqual([]);
  expect(f.runtime.closed).toBe(true);
});

it("exports full journal source and rebuilds report facts instead of forwarding worker summaries", async () => {
  const f = await fixture();
  f.input.patches[0].changes[0].before = ' aria-bogus="bad"';
  f.input.patches[0].changes[0].after = "";
  f.input.report.attempts = 999;
  f.input.report.needsHuman = 999;
  f.input.report.checks[0].durationMs = 999;
  f.input.report.outcomes[0].reason = "private worker summary";
  const verified = await verifyHostedCandidate(f.options, f.input, { prepare: f.prepare });
  expect(verified?.artifact.patches[0].changes[0]).toEqual({ path: location.file, before: source, after: source.replace(' aria-bogus="bad"', "") });
  expect(verified?.artifact.report).toMatchObject({ attempts: 1, needsHuman: 0,
    outcomes: [{ reason: null }], usage: f.options.reconciled.usage, providerVerification: "not-run" });
  expect(verified?.artifact.report.checks[0].durationMs).toBe(1);
  expect(verified?.artifact.report.startedAt).not.toBe(f.input.report.startedAt);
  expect(f.runtime.journal.exportPatches).toHaveBeenCalledExactlyOnceWith([task.id]);
  const log = await readFile(join(f.runtime.evidenceDir, "run.jsonl"), "utf8");
  expect(log).toContain(verified ? hostedVerifiedArtifactDigest(verified.artifact) : "missing");
  expect(log).not.toContain(source); expect(log).not.toContain("private worker summary");
});

it("withholds the artifact when journal export fails", async () => {
  const f = await fixture();
  f.runtime.journal.exportPatches.mockRejectedValueOnce(new Error("journal replay failed"));
  await expect(verifyHostedCandidate(f.options, f.input, { prepare: f.prepare })).rejects.toThrow("journal replay failed");
  expect(f.runtime.closed).toBe(true); expect(await readdir(f.options.tempRoot)).toEqual([]);
});

it.each(["failed", "unavailable", "contradictory", "duplicate"])("rejects independently %s production evidence", async kind => {
  const f = await fixture();
  const check = f.runtime.finalChecks[3];
  if (kind === "failed") { check.status = "failed"; check.exitCode = 1; }
  if (kind === "unavailable") { check.status = "unavailable"; check.available = false; check.exitCode = null; }
  if (kind === "contradictory") check.failureIds = ["actual-failure"];
  if (kind === "duplicate") f.runtime.finalChecks[3] = { ...f.runtime.finalChecks[0] };
  expect(await verifyHostedCandidate(f.options, f.input, { prepare: f.prepare })).toBeNull();
  expect(f.runtime.closed).toBe(true);
});

it.each(["usage", "unknown", "provider", "task", "manifest"])("rejects forged %s data before expensive verification", async kind => {
  const f = await fixture();
  if (kind === "usage") f.input.report.usage.spentUsd = 0.001;
  if (kind === "unknown") f.options.reconciled.unknownUsage = true;
  if (kind === "provider") f.input.report.providerVerification = "provider-api";
  if (kind === "task") f.input.patches[0].taskId = "ghost";
  if (kind === "manifest") f.input.patches[0].changes[0].path = "package.json";
  expect(await verifyHostedCandidate(f.options, f.input, { prepare: f.prepare })).toBeNull();
  expect(f.prepare).not.toHaveBeenCalled();
});

it("rejects a changed base SHA and source changed during verification, while cleaning private snapshots", async () => {
  const f = await fixture();
  await expect(verifyHostedCandidate({ ...f.options, verifiedBaseSha: "0".repeat(40) }, f.input, { prepare: f.prepare })).rejects.toThrow(/SHA/);
  expect(f.prepare).not.toHaveBeenCalled();
  f.runtime.onFinal = () => writeFile(join(f.options.repoPath, location.file), source + "// concurrent edit\n");
  await expect(verifyHostedCandidate(f.options, f.input, { prepare: f.prepare })).rejects.toThrow(/clean/);
  expect(f.runtime.closed).toBe(true);
  expect(await readdir(f.options.tempRoot)).toEqual([]);
  expect(await readFile(join(f.options.repoPath, location.file), "utf8")).toContain("concurrent edit");
});

it("cleans private snapshots if preparation fails", async () => {
  const f = await fixture();
  await expect(verifyHostedCandidate(f.options, f.input, { prepare: () => Promise.reject(new Error("prepare failed")) })).rejects.toThrow("prepare failed");
  expect(await readdir(f.options.tempRoot)).toEqual([]);
});

it("withholds the receipt and removes its private snapshot if verifier shutdown fails", async () => {
  const f = await fixture();
  f.runtime.close = () => Promise.reject(new Error("shutdown failed"));
  await expect(verifyHostedCandidate(f.options, f.input, { prepare: f.prepare })).rejects.toThrow("shutdown failed");
  expect(await readdir(f.options.tempRoot)).toEqual([]);
});
