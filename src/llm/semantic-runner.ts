import { defaults } from "../config.js";
import type { SemanticRepair } from "../core/repair.js";
import type { FixTask, LlmModelConfig } from "../types/schemas.js";
import type { DockerRepairSession } from "../runner/repair-session.js";
import { gatherRepairContext } from "./gather-context.js";
import { runSemanticRepair } from "./fixer.js";
import { LlmClient } from "./client.js";
import { BudgetLedger } from "./budget.js";
import { calculateUsageCost } from "./ai-sdk-provider.js";
import type { ModelPricing } from "./ai-sdk-provider.js";

export interface SemanticRunnerOptions {
  session: Pick<DockerRepairSession, "sourceRoot" | "evidenceDir" | "observations">;
  client: LlmClient;
  budget: BudgetLedger;
  model: LlmModelConfig;
  pricing: ModelPricing;
  maxAttempts?: number;
  guidanceForTask?: (task: FixTask) => string;
}

export function createSemanticRepair(options: SemanticRunnerOptions): SemanticRepair {
  return async (task, verify) => {
    const { context, images } = await gatherRepairContext({ root: options.session.sourceRoot, evidenceDir: options.session.evidenceDir, task, observations: options.session.observations });
    const guidance = options.guidanceForTask?.(task);
    // Byte-count upper bounds are deliberately conservative, including image expansion and retry feedback.
    // No provider call is authorized from an optimistic four-characters-per-token guess.
    const estimatedInputTokens = Buffer.byteLength(JSON.stringify(context)) + Buffer.byteLength(guidance ?? "") + images.reduce((sum, image) => sum + Math.ceil(image.data.byteLength * 4 / 3), 0) + 8192;
    const estimate = { estimatedInputTokens, maxOutputTokens: defaults.maxOutputTokens,
      estimatedCostUsd: calculateUsageCost({ inputTokens: estimatedInputTokens, outputTokens: defaults.maxOutputTokens }, options.pricing) };
    const result = await runSemanticRepair({ client: options.client, budget: options.budget, task, context, images, model: options.model, estimate, maxAttempts: options.maxAttempts ?? defaults.maxAttempts,
      ...(guidance === undefined ? {} : { guidance }),
      verifyPatch: async patch => {
        const verdict = await verify(patch);
        return verdict.accepted ? { accepted: true } : { accepted: false, check: verdict.check, reason: verdict.reason ?? "Verification did not pass" };
      } });
    return result.status === "accepted" ? { status: "accepted" } : { status: "needs-human", reason: result.lastFailure };
  };
}
