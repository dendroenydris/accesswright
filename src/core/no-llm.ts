import { applyCodemod } from "../fixers/codemods/index.js";
import { applyInlineContrastFix } from "../fixers/contrast-patch.js";
import { planFixTasks } from "../planner/planner.js";
import type { FixTask, Patch } from "../types/schemas.js";
import { verifyPerPatch } from "../verifier/per-patch.js";
import type { PageVerificationState } from "../verifier/per-patch.js";

export interface NoLlmRuntime {
  scan(): Promise<PageVerificationState>;
  readSource(path: string): Promise<string>;
  scanCandidate(patch: Patch): Promise<PageVerificationState>;
  applyVerifiedPatch(patch: Patch): Promise<void>;
}

export interface NoLlmRepairResult {
  fixed: number;
  rejected: number;
  needsHuman: number;
  attempts: number;
}

function createDeterministicPatch(
  sourceText: string,
  task: FixTask,
): Patch | null {
  if (task.route === "codemod") {
    return applyCodemod(sourceText, task);
  }
  if (task.route === "optimizer") {
    return applyInlineContrastFix(sourceText, task);
  }
  return null;
}

export async function runNoLlmRepair(
  runtime: NoLlmRuntime,
  maxAttempts = 20,
): Promise<NoLlmRepairResult> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }

  let fixed = 0;
  let rejected = 0;
  let attempts = 0;
  const blockedTaskIds = new Set<string>();

  while (attempts < maxAttempts) {
    const before = await runtime.scan();
    const tasks = planFixTasks(before.violations, { noLlm: true });
    const humanTasks = tasks.filter((task) => task.route === "human");

    let selected: { task: FixTask; patch: Patch } | null = null;
    for (const task of tasks) {
      if (
        task.route === "human" ||
        task.source === null ||
        blockedTaskIds.has(task.id)
      ) {
        continue;
      }

      const sourceText = await runtime.readSource(task.source.file);
      const patch = createDeterministicPatch(sourceText, task);
      if (patch === null) {
        blockedTaskIds.add(task.id);
        continue;
      }

      selected = { task, patch };
      break;
    }

    if (selected === null) {
      const unresolvedDeterministic = tasks.filter(
        (task) => task.route !== "human" && blockedTaskIds.has(task.id),
      ).length;
      return {
        fixed,
        rejected,
        needsHuman: humanTasks.length + unresolvedDeterministic,
        attempts,
      };
    }

    attempts += 1;
    const after = await runtime.scanCandidate(selected.patch);
    const verification = verifyPerPatch({
      task: selected.task,
      before,
      after,
    });

    if (!verification.accepted) {
      rejected += 1;
      blockedTaskIds.add(selected.task.id);
      continue;
    }

    await runtime.applyVerifiedPatch(selected.patch);
    fixed += 1;
  }

  const finalState = await runtime.scan();
  const unresolved = planFixTasks(finalState.violations, { noLlm: true });
  return {
    fixed,
    rejected,
    needsHuman: unresolved.length,
    attempts,
  };
}
