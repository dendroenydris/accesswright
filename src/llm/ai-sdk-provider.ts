import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import {
  createOpenAI,
} from "@ai-sdk/openai";
import type { OpenAILanguageModelResponsesOptions } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateText,
  Output,
} from "ai";
import type { LanguageModel } from "ai";
import type { z } from "zod";

import type {
  LlmCallRequest,
  LlmModelConfig,
  LlmProvider,
  LlmProviderResponse,
} from "./types.js";

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

    const result = await generateText({
      model: languageModel(request.model, this.environment),
      output: Output.object({ schema }),
      prompt: request.prompt,
      ...(request.system === undefined ? {} : { system: request.system }),
      ...(effort === undefined
        ? {}
        : {
            providerOptions: {
              openai: {
                reasoningEffort: effort,
                reasoningSummary: null,
              } satisfies OpenAILanguageModelResponsesOptions,
            },
          }),
    });

    const inputTokens = result.usage.inputTokens ?? 0;
    const outputTokens = result.usage.outputTokens ?? 0;
    return {
      object: result.output,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: calculateUsageCost(
          { inputTokens, outputTokens },
          pricing,
        ),
      },
    };
  }
}
