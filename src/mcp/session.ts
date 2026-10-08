import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { loadConfig } from "../config.js";
import { planFixTasks } from "../planner/planner.js";
import { DockerRepairSession } from "../runner/repair-session.js";
import type { RepairSessionOptions } from "../runner/repair-session.js";
import type { ProductionCheckResult } from "../runner/production-checks.js";
import { copyTargetSnapshot } from "../sandbox/source-boundary.js";
import { observationsToState } from "../scanner/observations.js";
import type { BrowserObservation } from "../scanner/observations.js";
import { PatchSchema } from "../types/schemas.js";
import type { FixTask, Patch } from "../types/schemas.js";
import { verifyPerPatch } from "../verifier/per-patch.js";
import type { PerPatchVerificationResult } from "../verifier/per-patch.js";
import type { FinalVerificationResult } from "../verifier/final.js";
import { compareSourceSnapshots } from "./source-diff.js";

export interface McpRepairRuntime {
  readonly sourceRoot: string;
  readonly routes: string[];
  readonly observations: BrowserObservation[];
  readonly baselineChecks: ProductionCheckResult[];
  readonly finalChecks: ProductionCheckResult[];
  affectedRoutes(paths: readonly string[]): string[];
  applyPatch(patch: Patch): Promise<Patch>;
  revertPatch(patch: Patch): Promise<void>;
  scan(routes: readonly string[], generation: string): Promise<BrowserObservation[]>;
  updateObservations(after: BrowserObservation[]): void;
  record(patch: Patch, task: FixTask, verification: PerPatchVerificationResult): Promise<void>;
  verifyFinal(): Promise<FinalVerificationResult>;
  close(): Promise<void>;
}

export interface McpAgentVerifierOptions {
  repoPath: string;
  tempRoot: string;
  runtimeRoot: string;
  offline?: boolean;
}

export interface McpScanResult {
  sessionId: string;
  routes: string[];
  tasks: Array<Pick<FixTask, "id" | "ruleId" | "criterion" | "route" | "source" | "routes">>;
  baselineChecks: Array<{ check: string; status: string }>;
}

export interface McpVerifyResult {
  accepted: boolean;
  stage: "source" | "per-patch" | "production" | "complete";
  check: string;
  reason: string | null;
  evidenceDir: string | null;
}

type Prepare = (options: RepairSessionOptions) => Promise<McpRepairRuntime>;
interface ActiveSession {
  id: string;
  runtime: McpRepairRuntime;
  tasks: Map<string, FixTask>;
  evidenceDir: string;
}

const TaskIdSchema = z.string().min(1).max(1024);
const requiredChecks = ["build", "typecheck", "lint", "tests"] as const;

/**
 * A coding agent may edit its own checkout between scan() and verify().
 * Verification runs ONLY against source copies in Docker; host source is never
 * auto-written, undone, committed, pushed or exposed in tool result bodies.
 */
export class McpAgentVerifier {
  private active: ActiveSession | null = null;
  private generation = 0;
  private readonly prepare: Prepare;
  private readonly options: McpAgentVerifierOptions;

  constructor(
    options: McpAgentVerifierOptions,
    dependencies: { prepare?: Prepare } = {},
  ) {
    this.options = options;
    this.prepare = dependencies.prepare ?? (input => DockerRepairSession.prepare(input));
  }

  async scan(): Promise<McpScanResult> {
    await this.close();
    await mkdir(this.options.tempRoot, { recursive: true });
    const config = this.options.offline === undefined
      ? undefined
      : await loadConfig(this.options.repoPath, { offline: this.options.offline });
    const runtime = await this.prepare({
      repoPath: this.options.repoPath,
      tempRoot: this.options.tempRoot,
      runtimeRoot: this.options.runtimeRoot,
      ...(config === undefined ? {} : { config }),
      retainEvidence: false,
      privateDiagnostics: false,
    });
    const id = randomUUID();
    const tasks = planFixTasks(observationsToState(runtime.observations).violations);
    this.active = {
      id,
      runtime,
      tasks: new Map(tasks.map(task => [task.id, task])),
      evidenceDir: "evidenceDir" in runtime && typeof runtime.evidenceDir === "string"
        ? runtime.evidenceDir
        : "",
    };
    return {
      sessionId: id,
      routes: [...runtime.routes],
      tasks: tasks.map(({ id: taskId, ruleId, criterion, route, source, routes }) => ({
        id: taskId, ruleId, criterion, route, source, routes,
      })),
      baselineChecks: runtime.baselineChecks.map(({ check, status }) => ({ check, status })),
    };
  }

  async verify(rawTaskId: string): Promise<McpVerifyResult> {
    const taskId = TaskIdSchema.parse(rawTaskId);
    const active = this.active;
    if (!active) throw new Error("MCP scan session is absent; scan again");
    const task = active.tasks.get(taskId);
    if (!task || !task.source || task.route === "human") {
      return { accepted: false, stage: "source", check: "target", reason: "Task has no editable mapped source", evidenceDir: null };
    }

    const scratch = await mkdtemp(join(this.options.tempRoot, "mcp-candidate-"));
    let applied: Patch | undefined;
    let recorded = false;
    try {
      const snapshot = join(scratch, "source");
      await copyTargetSnapshot(this.options.repoPath, snapshot);
      const changes = await compareSourceSnapshots(active.runtime.sourceRoot, snapshot);
      if (changes.length === 0) {
        return { accepted: false, stage: "source", check: "target", reason: "No edited source files were found", evidenceDir: null };
      }
      const patch = PatchSchema.parse({ taskId, changes });
      const routes = [...new Set([...task.routes, ...active.runtime.affectedRoutes(changes.map(item => item.path))])];
      const before = active.runtime.observations.filter(page => routes.includes(page.route));
      applied = await active.runtime.applyPatch(patch);

      let after: BrowserObservation[];
      let verdict: PerPatchVerificationResult;
      try {
        after = await active.runtime.scan(routes, "mcp-candidate-" + ++this.generation);
        verdict = verifyPerPatch({
          task, before: observationsToState(before), after: observationsToState(after),
        });
        if (!verdict.accepted && verdict.check === "new-violation") {
          after = await active.runtime.scan(routes, "mcp-confirm-" + ++this.generation);
          verdict = verifyPerPatch({
            task, before: observationsToState(before), after: observationsToState(after),
          });
        }
      } catch {
        await active.runtime.revertPatch(applied);
        applied = undefined;
        active.runtime.updateObservations(await active.runtime.scan(routes, "mcp-recover-" + ++this.generation));
        return { accepted: false, stage: "per-patch", check: "probe", reason: "Candidate browser scan failed; sandbox source restored", evidenceDir: null };
      }

      if (!verdict.accepted) {
        await active.runtime.revertPatch(applied);
        applied = undefined;
        active.runtime.updateObservations(await active.runtime.scan(routes, "mcp-revert-" + ++this.generation));
        return { accepted: false, stage: "per-patch", check: verdict.check, reason: verdict.reason, evidenceDir: null };
      }

      await active.runtime.record(applied, task, verdict);
      recorded = true;
      active.runtime.updateObservations(after);
      const final = await active.runtime.verifyFinal();
      // A coding agent can continue editing its checkout during Docker checks.
      // Never accept a verified snapshot after the host source has gone stale.
      const hostAfter = join(scratch, "host-after-verification");
      await copyTargetSnapshot(this.options.repoPath, hostAfter);
      const staleEdits = await compareSourceSnapshots(snapshot, hostAfter);
      if (staleEdits.length > 0) {
        await this.close();
        return {
          accepted: false,
          stage: "source",
          check: "stale",
          reason: "Host source changed during production verification; rescan required",
          evidenceDir: null,
        };
      }

      const passed = requiredChecks.every(name => {
        const matching = active.runtime.finalChecks.filter(check => check.check === name);
        return matching.length === 1 && matching[0]?.available === true && matching[0].status === "passed";
      });
      const accepted = final.failures.length === 0 && final.acceptedFixIds.includes(task.id) && passed;
      const result: McpVerifyResult = {
        accepted,
        stage: accepted ? "complete" : "production",
        check: accepted ? "ok" : "final",
        reason: accepted ? null : "Final production verifier failed or a required check was unavailable",
        evidenceDir: active.evidenceDir || null,
      };
      await this.close();
      return result;
    } catch (error) {
      if (applied !== undefined && !recorded) {
        try { await active.runtime.revertPatch(applied); }
        catch { await this.close(); throw new Error("MCP sandbox rollback could not be proven"); }
      }
      await this.close();
      throw error;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = null;
    await active.runtime.close();
  }
}
