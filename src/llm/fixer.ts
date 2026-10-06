import { z } from "zod";

import type { CallEstimate, BudgetLedger } from "./budget.js";
import { LlmClient } from "./client.js";
import type { RepairContext } from "./context.js";
import { getRepairGuidance } from "./guidance.js";
import type { LlmModelConfig } from "./types.js";
import { PatchSchema } from "../types/schemas.js";
import type { FixTask, Patch } from "../types/schemas.js";

export interface PatchVerificationAccepted {
  accepted: true;
}

export interface PatchVerificationRejected {
  accepted: false;
  check: string;
  reason: string;
}

export type PatchVerification =
  | PatchVerificationAccepted
  | PatchVerificationRejected;

export interface SemanticRepairOptions {
  client: LlmClient;
  budget: BudgetLedger;
  task: FixTask;
  context: RepairContext;
  model: LlmModelConfig;
  estimate: CallEstimate;
  maxAttempts?: number;
  verifyPatch: (patch: Patch) => Promise<PatchVerification>;
}

export type SemanticRepairResult =
  | {
      status: "accepted";
      patch: Patch;
      attempts: number;
    }
  | {
      status: "needs-human";
      reason: "budget" | "retry-exhausted";
      attempts: number;
      lastFailure: string;
    };

function patchSchemaForTask(
  task: FixTask,
  context: RepairContext,
): z.ZodType<Patch> {
  const allowedPaths = new Set([
    context.component.file,
    ...context.callSites.map((callSite) => callSite.file),
  ]);

  return PatchSchema.superRefine((patch, refinement) => {
    if (patch.taskId !== task.id) {
      refinement.addIssue({
        code: "custom",
        message: `Patch taskId must equal ${task.id}`,
      });
    }

    for (const change of patch.changes) {
      if (!allowedPaths.has(change.path)) {
        refinement.addIssue({
          code: "custom",
          message: `Patch path is outside deterministic context: ${change.path}`,
        });
      }
    }
  });
}

function basePrompt(task: FixTask, context: RepairContext): string {
  return [
    "Repair exactly the accessibility task below.",
    "Return only a source patch that matches the required structured schema.",
    "Do not edit manifests, lockfiles, build configuration, CI, or files outside the supplied deterministic context.",
    `Rule: ${task.ruleId}`,
    `WCAG criterion: ${task.criterion}`,
    `Source: ${context.component.file}:${context.component.line}:${context.component.column}`,
    `Guidance: ${getRepairGuidance(task.ruleId)}`,
    `Deterministic context: ${JSON.stringify(context)}`,
  ].join("\n");
}

function feedbackPrompt(
  originalPrompt: string,
  feedback: string | null,
): string {
  if (feedback === null) return originalPrompt;
  return [
    originalPrompt,
    "",
    `Previous attempt failed: ${feedback}`,
    "Correct that specific failure without broadening the patch.",
  ].join("\n");
}

export async function runSemanticRepair(
  options: SemanticRepairOptions,
): Promise<SemanticRepairResult> {
  if (options.task.route !== "llm" || options.task.source === null) {
    return {
      status: "needs-human",
      reason: "retry-exhausted",
      attempts: 0,
      lastFailure: "Task is not eligible for the LLM semantic fixer",
    };
  }

  const schema = patchSchemaForTask(options.task, options.context);
  const prompt = basePrompt(options.task, options.context);
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new Error("maxAttempts must be an integer between 1 and 3");
  }
  let feedback: string | null = null;
  let lastFailure = "No attempt made";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const authorization = options.budget.authorize(options.estimate);
    if (!authorization.allowed) {
      return {
        status: "needs-human",
        reason: "budget",
        attempts: attempt - 1,
        lastFailure: authorization.message,
      };
    }

    const result = await options.client.callStructured(
      {
        taskType: "semantic-repair",
        model: options.model,
        prompt: feedbackPrompt(prompt, feedback),
        maxOutputTokens: options.estimate.maxOutputTokens,
      },
      schema,
    );

    if (result.usage !== undefined) {
      options.budget.recordUsage(result.usage);
    }

    if (result.status === "rejected") {
      lastFailure = `${result.reason}: ${result.message}`;
      feedback = lastFailure;
      continue;
    }

    const verification = await options.verifyPatch(result.value);
    if (verification.accepted) {
      return {
        status: "accepted",
        patch: result.value,
        attempts: attempt,
      };
    }

    const source = options.task.source;
    lastFailure = [
      `rule=${options.task.ruleId}`,
      `source=${source.file}:${source.line}:${source.column}`,
      `check=${verification.check}`,
      `reason=${verification.reason}`,
    ].join("; ");
    feedback = lastFailure;
  }

  return {
    status: "needs-human",
    reason: "retry-exhausted",
    attempts: maxAttempts,
    lastFailure,
  };
}
