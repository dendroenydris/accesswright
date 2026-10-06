import type { z } from "zod";
import type { LlmModelConfig as ConfigModel } from "../types/schemas.js";


export type LlmModelConfig = ConfigModel;

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface LlmCallRequest {
  taskType: string;
  model: LlmModelConfig;
  prompt: string;
  system?: string;
  maxOutputTokens: number;
}

export interface LlmProviderResponse {
  object: unknown;
  usage: LlmUsage;
}

export interface LlmProvider {
  generateObject(
    request: LlmCallRequest,
    schema: z.ZodType<unknown>,
  ): Promise<LlmProviderResponse>;
}
