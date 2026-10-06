import { describe, expect, it } from "vitest";

import { BudgetLedger } from "../../src/llm/budget.js";
import { LlmClient } from "../../src/llm/client.js";
import { runSemanticRepair } from "../../src/llm/fixer.js";
import type { RepairContext } from "../../src/llm/context.js";
import type { FixTask, Patch, Violation } from "../../src/types/schemas.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";

function task(): FixTask {
  const source = { file: "components/IconButton.tsx", line: 2, column: 10 };
  const item: Violation = {
    ruleId: "button-name",
    impact: "critical",
    route: "/",
    target: ["button"],
    html: "<button></button>",
    failureSummary: "button has no accessible name",
    source,
  };
  return {
    id: "llm:4.1.2:button-name:components/IconButton.tsx:2:10",
    ruleId: "button-name",
    criterion: "4.1.2",
    kind: "semantic",
    route: "llm",
    source,
    routes: ["/"],
    violations: [item],
  };
}

function context(): RepairContext {
  return {
    component: {
      file: "components/IconButton.tsx",
      line: 2,
      column: 10,
      sourceExcerpt: 'export const IconButton = () => <button></button>;\n',
    },
    callSites: [
      {
        file: "app/page.tsx",
        line: 4,
        column: 3,
        source: '<IconButton aria-label="Save" />',
      },
    ],
    page: {
      title: "Editor",
      surroundingText: "Save your changes",
      caption: null,
      linkTarget: null,
    },
    screenshotPath: null,
  };
}

function patch(taskId = task().id): Patch {
  return {
    taskId,
    changes: [
      {
        path: "components/IconButton.tsx",
        before: 'export const IconButton = () => <button></button>;\n',
        after:
          'export const IconButton = () => <button aria-label="Save"></button>;\n',
      },
    ],
  };
}

function budget(maxRunCostUsd = 1): BudgetLedger {
  return new BudgetLedger({
    maxRunCostUsd,
    maxTaskTokens: 5_000,
  });
}

const model = {
  provider: "openai" as const,
  id: "fake-model",
  reasoningEffort: "high",
};

const estimate = {
  estimatedCostUsd: 0.01,
  estimatedInputTokens: 500,
  maxOutputTokens: 500,
};

describe("runSemanticRepair", () => {
  it("returns the first verified structured patch", async () => {
    const provider = new FakeLlmProvider([
      {
        object: patch(),
        usage: { inputTokens: 300, outputTokens: 80, costUsd: 0.004 },
      },
    ]);
    const ledger = budget();

    const result = await runSemanticRepair({
      client: new LlmClient(provider),
      budget: ledger,
      task: task(),
      context: context(),
      model,
      estimate,
      verifyPatch: () => Promise.resolve({ accepted: true }),
    });

    expect(result).toMatchObject({
      status: "accepted",
      attempts: 1,
      patch: patch(),
    });
    expect(ledger.snapshot().spentUsd).toBe(0.004);
  });

  it("retries after a schema rejection and includes structured feedback", async () => {
    const provider = new FakeLlmProvider([
      {
        object: { nope: true },
        usage: { inputTokens: 200, outputTokens: 20, costUsd: 0.002 },
      },
      {
        object: patch(),
        usage: { inputTokens: 250, outputTokens: 60, costUsd: 0.003 },
      },
    ]);

    const result = await runSemanticRepair({
      client: new LlmClient(provider),
      budget: budget(),
      task: task(),
      context: context(),
      model,
      estimate,
      verifyPatch: () => Promise.resolve({ accepted: true }),
    });

    expect(result).toMatchObject({ status: "accepted", attempts: 2 });
    expect(provider.requests[1]?.prompt).toMatch(/previous attempt/i);
    expect(provider.requests[1]?.prompt).toMatch(/schema/i);
    expect(provider.requests[1]?.maxOutputTokens).toBe(
      estimate.maxOutputTokens,
    );
  });

  it("retries after verifier rejection with rule/source/check feedback", async () => {
    const provider = new FakeLlmProvider([
      {
        object: patch(),
        usage: { inputTokens: 200, outputTokens: 50, costUsd: 0.002 },
      },
      {
        object: patch(),
        usage: { inputTokens: 220, outputTokens: 50, costUsd: 0.002 },
      },
    ]);
    let calls = 0;

    const result = await runSemanticRepair({
      client: new LlmClient(provider),
      budget: budget(),
      task: task(),
      context: context(),
      model,
      estimate,
      verifyPatch: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? {
                accepted: false,
                check: "aria-tree",
                reason: "accessible name disappeared",
              }
            : { accepted: true },
        );
      },
    });

    expect(result).toMatchObject({ status: "accepted", attempts: 2 });
    expect(provider.requests[1]?.prompt).toContain("button-name");
    expect(provider.requests[1]?.prompt).toContain("components/IconButton.tsx:2:10");
    expect(provider.requests[1]?.prompt).toContain("aria-tree");
  });

  it("stops before calling the provider when the budget gate rejects the estimate", async () => {
    const provider = new FakeLlmProvider([
      {
        object: patch(),
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
      },
    ]);

    const result = await runSemanticRepair({
      client: new LlmClient(provider),
      budget: budget(0.005),
      task: task(),
      context: context(),
      model,
      estimate,
      verifyPatch: () => Promise.resolve({ accepted: true }),
    });

    expect(result).toMatchObject({
      status: "needs-human",
      reason: "budget",
      attempts: 0,
    });
    expect(provider.requests).toHaveLength(0);
  });

  it("fails closed when a patch edits a file outside deterministic context", async () => {
    const outside = patch();
    outside.changes[0] = {
      ...outside.changes[0],
      path: "app/other.tsx",
    };
    const provider = new FakeLlmProvider(
      Array.from({ length: 3 }, () => ({
        object: outside,
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
      })),
    );

    const result = await runSemanticRepair({
      client: new LlmClient(provider),
      budget: budget(),
      task: task(),
      context: context(),
      model,
      estimate,
      verifyPatch: () => Promise.resolve({ accepted: true }),
    });

    expect(result).toMatchObject({
      status: "needs-human",
      reason: "retry-exhausted",
      attempts: 3,
    });
  });
});
