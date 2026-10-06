import { describe, expect, it } from "vitest";
import { z } from "zod";

import { LlmClient } from "../../src/llm/client.js";
import { LlmStructuredOutputError } from "../../src/llm/errors.js";
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

  it("preserves billed usage for provider-side structured-output failures", async () => {
    const provider = new FakeLlmProvider([
      {
        error: new LlmStructuredOutputError(
          "structured output validation failed",
          { inputTokens: 90, outputTokens: 30, costUsd: 0.002 },
        ),
      },
    ]);
    const client = new LlmClient(provider);

    await expect(
      client.callStructured(request(), AnswerSchema),
    ).resolves.toMatchObject({
      status: "rejected",
      reason: "schema",
      message: "structured output validation failed",
      usage: { inputTokens: 90, outputTokens: 30, costUsd: 0.002 },
    });
  });

  it("can use a broad provider schema and stricter local validation schema", async () => {
    const providerSchema = z.object({ value: z.string() });
    const validationSchema = providerSchema.refine(
      (value) => value.value === "expected",
      { message: "value must match deterministic context" },
    );
    const provider = new FakeLlmProvider([
      {
        object: { value: "wrong" },
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      },
    ]);
    const client = new LlmClient(provider);

    const result = await client.callStructured(
      request(),
      validationSchema,
      providerSchema,
    );

    expect(result).toMatchObject({
      status: "rejected",
      reason: "schema",
      message: "value must match deterministic context",
    });
    expect(provider.schemas[0]).toBe(providerSchema);
  });
});
