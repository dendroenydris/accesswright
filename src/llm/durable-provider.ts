import { createHash } from "node:crypto";
import type { z } from "zod";
import { calculateUsageCost, normalizeBilledUsage } from "./ai-sdk-provider.js";
import type { ModelPricing } from "./ai-sdk-provider.js";
import { LlmStructuredOutputError } from "./errors.js";
import type { DurableSpendLedger } from "./durable-spend.js";
import type { LlmCallRequest, LlmModelConfig, LlmProvider, LlmProviderResponse } from "./types.js";

export interface DurableProviderOptions {
  ledger: DurableSpendLedger;
  model: LlmModelConfig;
  /** Verified model context-window upper bound, not an optimistic prompt-length estimate. */
  maxInputTokens: number;
  pricing: ModelPricing;
  /** Optional operator deadline for a dated pricing/authorization snapshot. */
  expiresAt?: string;
}

/** One durable reservation per actual provider invocation; SDK retries remain disabled. */
export class DurableBudgetProvider implements LlmProvider {
  private readonly inner: LlmProvider;
  private readonly options: DurableProviderOptions;
  constructor(inner: LlmProvider, options: DurableProviderOptions) {
    if (!Number.isSafeInteger(options.maxInputTokens) || options.maxInputTokens < 1) throw new Error("A verified model context-window bound is required");
    calculateUsageCost({ inputTokens: 1, outputTokens: 1 }, options.pricing);
    if (options.expiresAt && !Number.isFinite(Date.parse(options.expiresAt))) throw new Error("Invalid pricing expiry");
    this.inner = inner;
    this.options = options;
  }

  async generateObject(request: LlmCallRequest, schema: z.ZodType<unknown>): Promise<LlmProviderResponse> {
    const { model, ledger, pricing, maxInputTokens, expiresAt } = this.options;
    if (request.model.provider !== model.provider || request.model.id !== model.id || request.model.baseURL !== model.baseURL || request.model.apiKeyEnv !== model.apiKeyEnv) throw new Error("Model substitution is outside the priced budget authorization");
    if (expiresAt && Date.now() >= Date.parse(expiresAt)) throw new Error("Dated model pricing authorization has expired");
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) throw new Error("A bounded model output is required");
    const upperBoundUsd = calculateUsageCost({ inputTokens: maxInputTokens, outputTokens: request.maxOutputTokens }, pricing);
    const id = await ledger.reserve(`${model.provider}:${model.id}`, upperBoundUsd, createHash("sha256").update(request.prompt).digest("hex"));
    let response: LlmProviderResponse;
    try { response = await this.inner.generateObject(request, schema); }
    catch (error: unknown) {
      if (error instanceof LlmStructuredOutputError && error.usage !== undefined) {
        const usage = normalizeBilledUsage(error.usage, pricing);
        await ledger.settle(id, usage);
        throw new LlmStructuredOutputError(error.message, usage);
      }
      await ledger.recordUnknown(id);
      throw error;
    }
    const usage = normalizeBilledUsage(response.usage, pricing);
    await ledger.settle(id, usage);
    return { object: response.object, usage };
  }
}
