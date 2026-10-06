import { describe, expect, it } from "vitest";

import { BudgetLedger } from "../../src/llm/budget.js";

describe("BudgetLedger", () => {
  it("authorizes an estimated call inside both cost and token caps", () => {
    const ledger = new BudgetLedger({
      maxRunCostUsd: 5,
      maxTaskTokens: 4_000,
    });

    expect(
      ledger.authorize({
        estimatedCostUsd: 0.5,
        estimatedInputTokens: 1_000,
        maxOutputTokens: 500,
      }),
    ).toEqual({ allowed: true });
  });

  it("blocks before a call that would exceed the remaining run budget", () => {
    const ledger = new BudgetLedger({
      maxRunCostUsd: 1,
      maxTaskTokens: 4_000,
    });
    ledger.recordUsage({
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.8,
    });

    expect(
      ledger.authorize({
        estimatedCostUsd: 0.25,
        estimatedInputTokens: 100,
        maxOutputTokens: 100,
      }),
    ).toMatchObject({
      allowed: false,
      reason: "cost",
    });
  });

  it("blocks before a call whose estimated task tokens exceed the cap", () => {
    const ledger = new BudgetLedger({
      maxRunCostUsd: 5,
      maxTaskTokens: 1_000,
    });

    expect(
      ledger.authorize({
        estimatedCostUsd: 0.1,
        estimatedInputTokens: 800,
        maxOutputTokens: 300,
      }),
    ).toMatchObject({
      allowed: false,
      reason: "tokens",
    });
  });

  it("tracks actual usage instead of estimated usage", () => {
    const ledger = new BudgetLedger({
      maxRunCostUsd: 5,
      maxTaskTokens: 4_000,
    });

    ledger.recordUsage({
      inputTokens: 900,
      outputTokens: 120,
      costUsd: 0.037,
    });

    expect(ledger.snapshot()).toEqual({
      spentUsd: 0.037,
      inputTokens: 900,
      outputTokens: 120,
      remainingUsd: 4.963,
    });
  });

  it("rejects invalid negative or non-finite cost data", () => {
    const ledger = new BudgetLedger({
      maxRunCostUsd: 5,
      maxTaskTokens: 4_000,
    });

    expect(() =>
      ledger.recordUsage({
        inputTokens: 1,
        outputTokens: 1,
        costUsd: Number.NaN,
      }),
    ).toThrow(/cost/i);
  });
});
