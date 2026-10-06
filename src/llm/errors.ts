import type { LlmUsage } from "./types.js";

export class LlmStructuredOutputError extends Error {
  readonly usage: LlmUsage | undefined;

  constructor(message: string, usage?: LlmUsage) {
    super(message);
    this.name = "LlmStructuredOutputError";
    this.usage = usage;
  }
}
