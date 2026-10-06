import { describe, expect, it } from "vitest";

import {
  calculateUsageCost,
  defaultApiKeyEnv,
  resolveApiKey,
} from "../../src/llm/ai-sdk-provider.js";

describe("AI SDK provider configuration", () => {
  it.each([
    ["openai", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["deepseek", "DEEPSEEK_API_KEY"],
    ["openai-compatible", "OPENAI_API_KEY"],
  ] as const)("uses the expected default key variable for %s", (provider, expected) => {
    expect(defaultApiKeyEnv(provider)).toBe(expected);
  });

  it("uses a configured key variable without exposing its value", () => {
    expect(
      resolveApiKey(
        {
          provider: "openai-compatible",
          id: "model",
          baseURL: "https://example.invalid/v1",
          apiKeyEnv: "PRIVATE_PROVIDER_KEY",
        },
        { PRIVATE_PROVIDER_KEY: "secret-value" },
      ),
    ).toBe("secret-value");
  });

  it("fails with the variable name, not the secret value, when a key is missing", () => {
    expect(() =>
      resolveApiKey(
        {
          provider: "openai",
          id: "model",
          apiKeyEnv: "MISSING_OPENAI_KEY",
        },
        {},
      ),
    ).toThrow(/MISSING_OPENAI_KEY/);
  });
});

describe("calculateUsageCost", () => {
  it("calculates conservative non-cached token cost", () => {
    expect(
      calculateUsageCost(
        { inputTokens: 2_000, outputTokens: 500 },
        { inputUsdPerMillion: 2, outputUsdPerMillion: 8 },
      ),
    ).toBeCloseTo(0.008, 10);
  });

  it("rejects missing or invalid pricing instead of treating it as free", () => {
    expect(() =>
      calculateUsageCost(
        { inputTokens: 10, outputTokens: 10 },
        null,
      ),
    ).toThrow(/pricing/i);
  });
});
