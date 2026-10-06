import type { LlmUsage } from "./types.js";

export interface BudgetPolicy {
  maxRunCostUsd: number;
  maxTaskTokens: number;
}

export interface CallEstimate {
  estimatedCostUsd: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
}

export type BudgetAuthorization =
  | { allowed: true }
  | {
      allowed: false;
      reason: "cost" | "tokens";
      message: string;
    };

function requireFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

export class BudgetLedger {
  private readonly policy: BudgetPolicy;
  private spentUsd = 0;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(policy: BudgetPolicy) {
    requireFiniteNonNegative(policy.maxRunCostUsd, "max run cost");
    requireNonNegativeInteger(policy.maxTaskTokens, "max task tokens");
    this.policy = policy;
  }

  authorize(estimate: CallEstimate): BudgetAuthorization {
    requireFiniteNonNegative(estimate.estimatedCostUsd, "estimated cost");
    requireNonNegativeInteger(
      estimate.estimatedInputTokens,
      "estimated input tokens",
    );
    requireNonNegativeInteger(estimate.maxOutputTokens, "max output tokens");

    const estimatedTokens =
      estimate.estimatedInputTokens + estimate.maxOutputTokens;
    if (estimatedTokens > this.policy.maxTaskTokens) {
      return {
        allowed: false,
        reason: "tokens",
        message:
          `Estimated task tokens ${estimatedTokens} exceed cap ` +
          `${this.policy.maxTaskTokens}`,
      };
    }

    const projectedCost = this.spentUsd + estimate.estimatedCostUsd;
    if (projectedCost > this.policy.maxRunCostUsd + Number.EPSILON) {
      return {
        allowed: false,
        reason: "cost",
        message:
          `Estimated run cost ${projectedCost} exceeds cap ` +
          `${this.policy.maxRunCostUsd}`,
      };
    }

    return { allowed: true };
  }

  recordUsage(usage: LlmUsage): void {
    requireNonNegativeInteger(usage.inputTokens, "input tokens");
    requireNonNegativeInteger(usage.outputTokens, "output tokens");
    requireFiniteNonNegative(usage.costUsd, "cost");
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.spentUsd += usage.costUsd;
  }

  snapshot(): {
    spentUsd: number;
    inputTokens: number;
    outputTokens: number;
    remainingUsd: number;
  } {
    return {
      spentUsd: this.spentUsd,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      remainingUsd: Math.max(0, this.policy.maxRunCostUsd - this.spentUsd),
    };
  }
}
