import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../../src/llm/budget.js";
import { buildProviderPrompt, normalizeBilledUsage } from "../../src/llm/ai-sdk-provider.js";
import { buildRepairContext } from "../../src/llm/context.js";

describe("LLM integration boundaries", () => {
  it("applies the token cap to all attempts for the same task", () => {
    const budget = new BudgetLedger({ maxRunCostUsd: 1, maxTaskTokens: 1000 });
    budget.recordUsage({ inputTokens: 600, outputTokens: 100, costUsd: 0.01 }, "task-a");
    const estimate = { estimatedCostUsd: 0.01, estimatedInputTokens: 300, maxOutputTokens: 100 };
    expect(budget.authorize(estimate, "task-a")).toMatchObject({ allowed: false, reason: "tokens" });
    expect(budget.authorize(estimate, "task-b")).toEqual({ allowed: true });
  });
  it("fails closed after a billable attempt returns no usable usage", () => {
    const budget = new BudgetLedger({ maxRunCostUsd: 1, maxTaskTokens: 1000 });
    budget.recordUnknownUsage();
    expect(budget.authorize({ estimatedCostUsd: 0, estimatedInputTokens: 1, maxOutputTokens: 1 }, "other-task")).toMatchObject({ allowed: false, reason: "unknown-usage" });
  });
  it("never translates missing or invalid provider token counts into zero", () => {
    expect(() => normalizeBilledUsage({ inputTokens: undefined, outputTokens: 10 }, { inputUsdPerMillion: 1, outputUsdPerMillion: 2 })).toThrow(/usage/i);
    expect(() => normalizeBilledUsage({ inputTokens: 10, outputTokens: -1 }, { inputUsdPerMillion: 1, outputUsdPerMillion: 2 })).toThrow(/usage/i);
    expect(normalizeBilledUsage({ inputTokens: 10, outputTokens: 2 }, { inputUsdPerMillion: 1, outputUsdPerMillion: 2 })).toEqual({ inputTokens: 10, outputTokens: 2, costUsd: 0.000014 });
  });
  it("sends actual in-memory image bytes, not an inaccessible screenshot path", () => {
    const data = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(buildProviderPrompt({ taskType: "test", model: { provider: "openai", id: "fake" }, prompt: "Describe the existing control", maxOutputTokens: 100,
      images: [{ data, mediaType: "image/png" }] })).toEqual({ messages: [{ role: "user", content: [{ type: "text", text: "Describe the existing control" }, { type: "file", data, mediaType: "image/png" }] }] });
  });
  it("bounds aggregate deterministic context, not just each individual call site", () => {
    const context = buildRepairContext({ source: { file: "components/Button.tsx", line: 1, column: 1, text: "<button />" },
      callSites: Array.from({ length: 1000 }, (_, index) => ({ file: `app/page-${index}.tsx`, line: 1, column: 1, source: "x".repeat(2000) })),
      page: { title: "Fixture", surroundingText: "Existing action", caption: null, linkTarget: null }, screenshotPath: null });
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(64000);
    expect(context.callSites.length).toBeLessThanOrEqual(12);
  });
});
