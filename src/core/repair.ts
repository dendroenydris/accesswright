import { defaults, isIgnoredPath } from "../config.js";
import { applyCodemod } from "../fixers/codemods/index.js";
import { applyRenderedContrastFix } from "../fixers/runtime-contrast.js";
import { applyHeadingOrderFix } from "../fixers/page-heading.js";
import { planFixTasks } from "../planner/planner.js";
import { PatchSchema } from "../types/schemas.js";
import { SourcePatchRejectedError } from "../sandbox/source-boundary.js";
import type { AccesswrightConfig, FixTask, Patch } from "../types/schemas.js";
import { observationsToState } from "../scanner/observations.js";
import type { BrowserObservation } from "../scanner/observations.js";
import { verifyPerPatch } from "../verifier/per-patch.js";
import type { PerPatchVerificationResult } from "../verifier/per-patch.js";
import type { FinalVerificationResult } from "../verifier/final.js";

export interface RepairRuntime {
  config: AccesswrightConfig;
  observations: BrowserObservation[];
  readSource(path: string): Promise<string>;
  applyPatch(patch: Patch): Promise<Patch>;
  revertPatch(patch: Patch): Promise<void>;
  scan(routes: readonly string[], generation: string): Promise<BrowserObservation[]>;
  affectedRoutes(paths: readonly string[]): string[];
  updateObservations(after: BrowserObservation[]): void;
  record(patch: Patch, task: FixTask, verification: PerPatchVerificationResult): Promise<void>;
  verifyFinal(): Promise<FinalVerificationResult>;
  finalPatch(): Promise<Patch | null>;
}

export interface SemanticRepairResult { status: "accepted" | "needs-human"; reason?: string }
export type SemanticRepair = (
  task: FixTask,
  verify: (patch: Patch) => Promise<PerPatchVerificationResult>,
) => Promise<SemanticRepairResult>;
export interface RepairOptions {
  noLlm?: boolean;
  maxTasks?: number;
  semanticRepair?: SemanticRepair;
  /** Coordinator-selected scope; excluded tasks still remain part of all regression scans. */
  includeTask?: (task: FixTask) => boolean;
  /** Single-shot baselines may supply proposals, but cannot replace either verification gate. */
  proposalRepair?: SemanticRepair;
  onVerification?: (task: FixTask, verdict: PerPatchVerificationResult) => void | Promise<void>;
}
export interface TaskOutcome {
  id: string;
  ruleId: string;
  criterion: string;
  route: string;
  status: "verified" | "rejected" | "needs-human" | "ignored" | "dropped";
  reason: string | null;
}
export interface RepairResult {
  status: "verified" | "blocked";
  fixed: number;
  rejected: number;
  needsHuman: number;
  ignored: number;
  attempts: number;
  patch: Patch | null;
  final: FinalVerificationResult;
  outcomes: TaskOutcome[];
}

function stableTaskKey(task: FixTask): string {
  return `${task.ruleId}|${task.violations.map(item => `${item.route}|${item.condition ?? "desktop-light"}|${item.target.join(" >> ")}`).sort().join(";")}`;
}

/** Runs candidates in an isolated runtime. It never writes to the user's original repository. */
export async function runRepair(runtime: RepairRuntime, options: RepairOptions = {}): Promise<RepairResult> {
  const maximum = options.maxTasks ?? defaults.maxTasks;
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error("maxTasks must be a positive integer");
  const completed = new Set<string>();
  const outcomes: TaskOutcome[] = [];
  let attempts = 0, handled = 0;
  const rank = { codemod: 0, optimizer: 1, llm: 2, human: 3 };
  while (handled < maximum) {
    const tasks = planFixTasks(observationsToState(runtime.observations).violations).filter(task => options.includeTask?.(task) ?? true).sort((a, b) => rank[a.route] - rank[b.route]);
    const task = tasks.find(item => !completed.has(stableTaskKey(item)));
    if (!task) break;
    const key = stableTaskKey(task);
    const outcome: TaskOutcome = { id: task.id, ruleId: task.ruleId, criterion: task.criterion, route: task.route, status: "needs-human", reason: null };
    completed.add(key);
    handled += 1;
    const ignored = runtime.config.ignore.rules.includes(task.ruleId) || (task.source !== null && isIgnoredPath(task.source.file, runtime.config.ignore.paths));
    if (ignored) { outcomes.push({ ...outcome, status: "ignored", reason: "explicit-ignore" }); continue; }
    if (task.route === "human" || task.source === null) { outcomes.push({ ...outcome, reason: "unsupported-or-unmapped" }); continue; }
    if (task.route === "llm" && (options.noLlm === true || (!options.semanticRepair && !options.proposalRepair))) {
      outcomes.push({ ...outcome, reason: options.noLlm ? "no-llm" : "provider-not-configured" }); continue;
    }
    let accepted: { patch: Patch; after: BrowserObservation[]; verification: PerPatchVerificationResult } | null = null;
    let lastVerification: PerPatchVerificationResult | null = null;
    const checkCandidate = async (input: Patch): Promise<PerPatchVerificationResult> => {
      if (accepted !== null) throw new Error("A candidate was already accepted for this task");
      const patch = PatchSchema.parse(input);
      if (patch.taskId !== task.id || patch.changes.some(change => isIgnoredPath(change.path, runtime.config.ignore.paths))) {
        return { accepted: false, check: "target", reason: "Patch task or ignored-path boundary violation" };
      }
      attempts += 1;
      const routes = [...new Set([...task.routes, ...runtime.affectedRoutes(patch.changes.map(change => change.path))])];
      const before = runtime.observations.filter(page => routes.includes(page.route));
      let applied: Patch;
      try { applied = await runtime.applyPatch(patch); }
      catch (error) {
        if (!(error instanceof SourcePatchRejectedError)) throw error;
        runtime.updateObservations(await runtime.scan(routes, `source-recovered-${attempts}`));
        lastVerification = { accepted: false, check: "target", reason: error.message };
        return lastVerification;
      }
      let after: BrowserObservation[];
      let verification: PerPatchVerificationResult;
      try {
        after = await runtime.scan(routes, `candidate-${attempts}`);
        verification = verifyPerPatch({ task, before: observationsToState(before), after: observationsToState(after) });
        // Re-evaluate a new axe finding once; persistence still rejects the candidate.
        if (!verification.accepted && verification.check === "new-violation") {
          after = await runtime.scan(routes, `candidate-${attempts}-confirm`);
          verification = verifyPerPatch({ task, before: observationsToState(before), after: observationsToState(after) });
        }
      } catch {
        await runtime.revertPatch(applied);
        runtime.updateObservations(await runtime.scan(routes, `recovered-${attempts}`));
        lastVerification = { accepted: false, check: "probe", reason: "Candidate scan failed; source restored" };
        return lastVerification;
      }
      lastVerification = verification;
      if (verification.accepted) {
        accepted = { patch: applied, after, verification };
      } else {
        await runtime.revertPatch(applied);
        runtime.updateObservations(await runtime.scan(routes, `reverted-${attempts}`));
      }
      return verification;
    };

    const verify = async (input: Patch): Promise<PerPatchVerificationResult> => {
      const verdict = await checkCandidate(input);
      await options.onVerification?.(task, verdict);
      return verdict;
    };
    if (options.proposalRepair && options.noLlm !== true) {
      const result = await options.proposalRepair(task, verify);
      if (result.status !== "accepted") outcome.reason = result.reason ?? "single-shot-proposal-unresolved";
    } else if (task.route === "llm") {
      const semantic = options.semanticRepair;
      if (!semantic) throw new Error("Semantic provider unexpectedly unavailable");
      const result = await semantic(task, verify);
      if (result.status !== "accepted") outcome.reason = result.reason ?? "semantic-repair-unresolved";
    } else {
      const source = await runtime.readSource(task.source.file);
      const decision = task.ruleId === "heading-order"
        ? applyHeadingOrderFix(source, task, runtime.observations)
        : task.route === "codemod"
          ? { patch: applyCodemod(source, task), reason: "deterministic-source-shape-not-supported" }
          : applyRenderedContrastFix(source, task, runtime.observations);
      const patch = decision.patch;
      if (patch === null) outcome.reason = decision.reason;
      else await verify(patch);
    }
    // TypeScript cannot infer assignments performed through the awaited verifier callback.
    const candidate = accepted as { patch: Patch; after: BrowserObservation[]; verification: PerPatchVerificationResult } | null;
    const checked = lastVerification as PerPatchVerificationResult | null;
    if (candidate !== null) {
      await runtime.record(candidate.patch, task, candidate.verification);
      runtime.updateObservations(candidate.after);
      outcomes.push({ ...outcome, status: "verified", reason: null });
    } else if (checked !== null) {
      outcomes.push({ ...outcome, status: "rejected", reason: checked.reason });
    } else outcomes.push(outcome);
  }
  const unresolved = planFixTasks(observationsToState(runtime.observations).violations).filter(task => (options.includeTask?.(task) ?? true) && !completed.has(stableTaskKey(task)));
  for (const task of unresolved) outcomes.push({ id: task.id, ruleId: task.ruleId, criterion: task.criterion, route: task.route, status: "needs-human", reason: "run-task-limit" });
  const final = await runtime.verifyFinal();
  const valid = final.failures.length === 0;
  for (const outcome of outcomes) if (outcome.status === "verified" && (!valid || !final.acceptedFixIds.includes(outcome.id))) {
    outcome.status = "dropped"; outcome.reason = valid ? "final-production-check" : "final-gate-blocked";
  }
  return {
    status: valid ? "verified" : "blocked",
    fixed: valid ? final.acceptedFixIds.length : 0,
    rejected: outcomes.filter(outcome => outcome.status === "rejected" || outcome.status === "dropped").length,
    needsHuman: outcomes.filter(outcome => outcome.status === "needs-human" || outcome.status === "rejected" || outcome.status === "dropped").length,
    ignored: outcomes.filter(outcome => outcome.status === "ignored").length,
    attempts,
    patch: valid ? await runtime.finalPatch() : null,
    final,
    outcomes,
  };
}
