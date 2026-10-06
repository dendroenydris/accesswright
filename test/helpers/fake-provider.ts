import type { z } from "zod";

import type {
  LlmProvider,
  LlmProviderResponse,
  LlmCallRequest,
} from "../../src/llm/types.js";

export type FakeLlmStep =
  | LlmProviderResponse
  | { error: Error };

export class FakeLlmProvider implements LlmProvider {
  readonly requests: LlmCallRequest[] = [];
  readonly schemas: z.ZodType<unknown>[] = [];
  private readonly steps: FakeLlmStep[];

  constructor(steps: readonly FakeLlmStep[]) {
    this.steps = [...steps];
  }

  generateObject(
    request: LlmCallRequest,
    schema: z.ZodType<unknown>,
  ): Promise<LlmProviderResponse> {
    this.requests.push(request);
    this.schemas.push(schema);
    const step = this.steps.shift();
    if (step === undefined) {
      return Promise.reject(new Error("Fake provider queue exhausted"));
    }
    if ("error" in step) {
      return Promise.reject(step.error);
    }
    return Promise.resolve(step);
  }
}
