import { describe, expect, it } from "vitest";
import { z } from "zod";

import { LlmClient } from "../../src/llm/client.js";
import type { LlmCallRequest } from "../../src/llm/types.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";

const AnswerSchema = z.object({
  patch: z.string().min(1),
  rationale: z.string().min(1),
});

function request(): LlmCallRequest {
  return {
    taskType: "semantic-repair",
    model: {
      provider: "openai",
      id: "fake-model",
      reasoningEffort: "high",
    },
    prompt: "Fix the missing accessible name.",
    maxOutputTokens: 512,
  };
}

describe("LlmClient structured output", () => {
  it("returns a zod-validated object with usage metadata", async () => {
    const provider = new FakeLlmProvider([
      {
        object: { patch: "diff", rationale: "adds a name" },
        usage: { inputTokens: 120, outputTokens: 40, costUsd: 0.002 },
      },
    ]);
    const client = new LlmClient(provider);

    const result = await client.callStructured(request(), AnswerSchema);

    expect(result).toEqual({
      status: "accepted",
      value: { patch: "diff", rationale: "adds a name" },
      usage: { inputTokens: 120, outputTokens: 40, costUsd: 0.002 },
    });
    expect(provider.requests).toHaveLength(1);
  });

  it("turns malformed structured output into a rejected attempt rather than throwing", async () => {
    const provider = new FakeLlmProvider([
      {
        object: { patch: "", rationale: 42 },
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
      },
    ]);
    const client = new LlmClient(provider);

    await expect(client.callStructured(request(), AnswerSchema)).resolves.toMatchObject({
      status: "rejected",
      reason: "schema",
    });
  });

  it("turns provider failures into a rejected attempt", async () => {
    const provider = new FakeLlmProvider([
      { error: new Error("rate limited") },
    ]);
    const client = new LlmClient(provider);

    await expect(client.callStructured(request(), AnswerSchema)).resolves.toMatchObject({
      status: "rejected",
      reason: "provider",
      message: "rate limited",
    });
  });
});
