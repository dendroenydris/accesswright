import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import {
  createOpenAI,
} from "@ai-sdk/openai";
import type { OpenAILanguageModelResponsesOptions } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateText,
  NoObjectGeneratedError,
  Output,
} from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import type { z } from "zod";

import type {
  LlmCallRequest,
  LlmModelConfig,
  LlmProvider,
  LlmProviderResponse,
} from "./types.js";
import { LlmStructuredOutputError } from "./errors.js";
import { defaults } from "../config.js";

export interface ModelPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export type PricingResolver = (
  model: LlmModelConfig,
) => ModelPricing | null;

const defaultKeyVariables: Readonly<
  Record<LlmModelConfig["provider"], string>
> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
};

export function defaultApiKeyEnv(
  provider: LlmModelConfig["provider"],
): string {
  return defaultKeyVariables[provider];
}

export function resolveApiKey(
  model: LlmModelConfig,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const variable = model.apiKeyEnv ?? defaultApiKeyEnv(model.provider);
  const value = environment[variable];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `Required provider API key environment variable is missing: ${variable}`,
    );
  }
  return value;
}

export function calculateUsageCost(
  usage: { inputTokens: number; outputTokens: number },
  pricing: ModelPricing | null,
): number {
  if (pricing === null) {
    throw new Error("Model pricing is required before a live LLM call");
  }
  for (const [label, value] of [
    ["input pricing", pricing.inputUsdPerMillion],
    ["output pricing", pricing.outputUsdPerMillion],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid ${label}: ${value}`);
    }
  }
  return (
    (usage.inputTokens * pricing.inputUsdPerMillion +
      usage.outputTokens * pricing.outputUsdPerMillion) /
    1_000_000
  );
}

export function normalizeBilledUsage(usage: { inputTokens?: number | undefined; outputTokens?: number | undefined }, pricing: ModelPricing | null) {
  const { inputTokens, outputTokens } = usage;
  if (inputTokens === undefined || outputTokens === undefined || !Number.isInteger(inputTokens) || !Number.isInteger(outputTokens) || inputTokens < 0 || outputTokens < 0) {
    throw new Error("Provider returned missing or invalid usage; billing must be reconciled before another call");
  }
  return { inputTokens, outputTokens, costUsd: calculateUsageCost({ inputTokens, outputTokens }, pricing) };
}

export function buildProviderPrompt(request: LlmCallRequest): { prompt: string } | { messages: ModelMessage[] } {
  if (!request.images?.length) return { prompt: request.prompt };
  if (request.images.length > 4 || request.images.some(image => image.data.byteLength === 0 || image.data.byteLength > 4 * 1024 * 1024)) throw new Error("Image context exceeds the configured bound");
  return { messages: [{ role: "user", content: [{ type: "text", text: request.prompt }, ...request.images.map(image => ({ type: "file" as const, data: image.data, mediaType: image.mediaType }))] }] };
}

function openAIReasoningEffort(
  value: string | undefined,
): OpenAILanguageModelResponsesOptions["reasoningEffort"] | undefined {
  if (value === undefined) return undefined;
  const allowed = new Set([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  if (!allowed.has(value)) {
    throw new Error(`Unsupported OpenAI reasoning effort: ${value}`);
  }
  return value;
}

function languageModel(
  config: LlmModelConfig,
  environment: Readonly<Record<string, string | undefined>>,
): LanguageModel {
  const apiKey = resolveApiKey(config, environment);

  if (config.provider === "openai") {
    const provider = createOpenAI({
      apiKey,
      ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
    });
    return provider(config.id);
  }

  if (config.provider === "anthropic") {
    const provider = createAnthropic({
      apiKey,
      ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
    });
    return provider(config.id);
  }

  if (config.provider === "deepseek") {
    const provider = createDeepSeek({
      apiKey,
      ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
    });
    return provider(config.id);
  }

  if (config.baseURL === undefined || config.baseURL.trim().length === 0) {
    throw new Error(
      "OpenAI-compatible provider requires a configured baseURL",
    );
  }

  const provider = createOpenAICompatible({
    name: "accesswright-compatible",
    baseURL: config.baseURL,
    apiKey,
    supportsStructuredOutputs: true,
  });
  return provider(config.id);
}

export class AiSdkLlmProvider implements LlmProvider {
  private readonly environment: Readonly<
    Record<string, string | undefined>
  >;
  private readonly pricing: PricingResolver;

  constructor(options: {
    environment?: Readonly<Record<string, string | undefined>>;
    pricing: PricingResolver;
  }) {
    this.environment = options.environment ?? process.env;
    this.pricing = options.pricing;
  }

  async generateObject(
    request: LlmCallRequest,
    schema: z.ZodType<unknown>,
  ): Promise<LlmProviderResponse> {
    const pricing = this.pricing(request.model);
    if (pricing === null) {
      throw new Error(
        `No pricing configured for ${request.model.provider}:${request.model.id}`,
      );
    }

    const effort =
      request.model.provider === "openai"
        ? openAIReasoningEffort(request.model.reasoningEffort)
        : undefined;

    try {
      const result = await generateText({
        model: languageModel(request.model, this.environment),
        output: Output.object({ schema }),
        ...buildProviderPrompt(request),
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(defaults.providerTimeoutMs),
        telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
        maxOutputTokens: request.maxOutputTokens,
        ...(request.system === undefined ? {} : { system: request.system }),
        ...(request.model.provider === "openai" ? {
          providerOptions: { openai: {
            store: false,
            serviceTier: "default",
            ...(effort === undefined ? {} : { reasoningEffort: effort, reasoningSummary: null, forceReasoning: true }),
          } satisfies OpenAILanguageModelResponsesOptions },
        } : {}),
      });

      return { object: result.output, usage: normalizeBilledUsage(result.usage, pricing) };
    } catch (error: unknown) {
      if (!NoObjectGeneratedError.isInstance(error)) {
        throw error;
      }

      const usage =
        error.usage === undefined
          ? undefined
          : normalizeBilledUsage(error.usage, pricing);
      throw new LlmStructuredOutputError(
        "structured output did not match provider schema",
        usage,
      );
    }
  }
}
