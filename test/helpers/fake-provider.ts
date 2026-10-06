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
  private readonly steps: FakeLlmStep[];

  constructor(steps: readonly FakeLlmStep[]) {
    this.steps = [...steps];
  }

  generateObject(request: LlmCallRequest): Promise<LlmProviderResponse> {
    this.requests.push(request);
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
