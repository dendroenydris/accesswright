import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  AiSdkLlmProvider,
} from "../../src/llm/ai-sdk-provider.js";
import { BudgetLedger } from "../../src/llm/budget.js";
import { LlmClient } from "../../src/llm/client.js";
import type { RepairContext } from "../../src/llm/context.js";
import { runSemanticRepair } from "../../src/llm/fixer.js";
import { createJsonlLlmObserver } from "../../src/llm/run-record.js";
import type {
  FixTask,
  Patch,
  Violation,
} from "../../src/types/schemas.js";
import { verifyPerPatch } from "../../src/verifier/per-patch.js";
import type {
  AccessibleNodeFact,
  PageVerificationState,
} from "../../src/verifier/per-patch.js";

const liveIt =
  process.env.ACCESSWRIGHT_LIVE_LLM === "1" ? it : it.skip;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required live-test environment variable: ${name}`);
  }
  return value;
}

function requiredNumber(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid non-negative number in ${name}`);
  }
  return value;
}

function accessibleNameFromPatch(patch: Patch): {
  name: string;
  text: string;
} | null {
  const change = patch.changes[0];
  if (change === undefined) return null;

  if (!change.after.includes("<p>Save changes</p>")) {
    return null;
  }
  if (!change.after.includes('data-action="save-changes"')) {
    return null;
  }

  const button = change.after.match(
    /<button\b([^>]*)>([\s\S]*?)<\/button>/i,
  );
  if (button === null) return null;

  const attributes = button[1] ?? "";
  const inner = (button[2] ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const ariaLabel = attributes.match(
    /\baria-label\s*=\s*["']([^"']+)["']/i,
  )?.[1]?.trim();

  const name = ariaLabel ?? inner;
  if (name !== "Save changes") return null;
  return { name, text: inner };
}

liveIt(
  "repairs a controlled button-name fixture with the verified OpenAI model",
  async () => {
    const fixturePath =
      "test/fixtures/llm-semantic/SaveButton.fixture.txt";
    const sourceText = await readFile(fixturePath, "utf8");
    const source = { file: fixturePath, line: 5, column: 7 };
    const violation: Violation = {
      ruleId: "button-name",
      impact: "critical",
      route: "/profile",
      target: ['button[data-action="save-changes"]'],
      html: '<button data-action="save-changes"></button>',
      failureSummary:
        "The button has no accessible name; the adjacent action text is Save changes.",
      source,
    };
    const task: FixTask = {
      id: `llm:4.1.2:button-name:${fixturePath}:5:7`,
      ruleId: "button-name",
      criterion: "4.1.2",
      kind: "semantic",
      route: "llm",
      source,
      routes: ["/profile"],
      violations: [violation],
    };
    const context: RepairContext = {
      component: {
        file: fixturePath,
        line: source.line,
        column: source.column,
        sourceExcerpt: sourceText,
      },
      callSites: [],
      page: {
        title: "Profile editor",
        surroundingText:
          "The empty button performs the Save changes action described immediately before it.",
        caption: null,
        linkTarget: null,
      },
      screenshotPath: null,
    };

    const modelId = requiredEnv("ACCESSWRIGHT_LIVE_MODEL");
    const inputPrice = requiredNumber(
      "ACCESSWRIGHT_LIVE_INPUT_USD_PER_MILLION",
    );
    const outputPrice = requiredNumber(
      "ACCESSWRIGHT_LIVE_OUTPUT_USD_PER_MILLION",
    );
    const maxRunCostUsd = requiredNumber(
      "ACCESSWRIGHT_LIVE_MAX_COST_USD",
    );
    const maxOutputTokens = requiredNumber(
      "ACCESSWRIGHT_LIVE_MAX_OUTPUT_TOKENS",
    );
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
      throw new Error("ACCESSWRIGHT_LIVE_MAX_OUTPUT_TOKENS must be a positive integer");
    }

    const estimatedInputTokens = 20_000;
    const estimatedCostUsd =
      (estimatedInputTokens * inputPrice +
        maxOutputTokens * outputPrice) /
      1_000_000;
    process.stdout.write(
      `ACCESSWRIGHT_LIVE_ESTIMATE=${JSON.stringify({
        estimatedInputTokens,
        maxOutputTokens,
        estimatedCostUsd,
        maxRunCostUsd,
      })}\n`,
    );

    const budget = new BudgetLedger({
      maxRunCostUsd,
      maxTaskTokens: estimatedInputTokens + maxOutputTokens,
    });
    const provider = new AiSdkLlmProvider({
      pricing: (model) =>
        model.provider === "openai" && model.id === modelId
          ? {
              inputUsdPerMillion: inputPrice,
              outputUsdPerMillion: outputPrice,
            }
          : null,
    });
    const recordPath =
      process.env.ACCESSWRIGHT_LIVE_RUN_RECORD ??
      join(process.cwd(), "live-run.jsonl");
    const client = new LlmClient(
      provider,
      createJsonlLlmObserver(recordPath),
    );

    const beforeAria: AccessibleNodeFact[] = [
      {
        id: "button:save-changes",
        role: "button",
        name: "",
        text: "",
        interactive: true,
      },
    ];
    const before: PageVerificationState = {
      violations: [violation],
      aria: beforeAria,
      probeFailures: [],
    };

    const result = await runSemanticRepair({
      client,
      budget,
      task,
      context,
      model: {
        provider: "openai",
        id: modelId,
        reasoningEffort: "high",
        apiKeyEnv: "OPENAI_KEY",
      },
      estimate: {
        estimatedCostUsd,
        estimatedInputTokens,
        maxOutputTokens,
      },
      maxAttempts: 2,
      verifyPatch: (patch) => {
        const accessible = accessibleNameFromPatch(patch);
        if (accessible === null) {
          return Promise.resolve({
            accepted: false,
            check: "aria-tree",
            reason:
              'Keep the fixture context unchanged and give the button the exact accessible name "Save changes".',
          });
        }

        const after: PageVerificationState = {
          violations: [],
          aria: [
            {
              id: "button:save-changes",
              role: "button",
              name: accessible.name,
              text: accessible.text,
              interactive: true,
            },
          ],
          probeFailures: [],
        };
        const verification = verifyPerPatch({ task, before, after });
        return Promise.resolve(
          verification.accepted
            ? { accepted: true }
            : {
                accepted: false,
                check: verification.check,
                reason: verification.reason ?? "Verifier rejected patch",
              },
        );
      },
    });

    if (result.status !== "accepted") {
      process.stderr.write(
        `ACCESSWRIGHT_LIVE_FAILURE=${JSON.stringify({
          reason: result.reason,
          lastFailure: result.lastFailure,
          attempts: result.attempts,
          usage: budget.snapshot(),
        })}\n`,
      );
      throw new Error(
        `Live semantic repair did not pass: ${result.reason}: ${result.lastFailure}`,
      );
    }

    const snapshot = budget.snapshot();
    expect(snapshot.spentUsd).toBeLessThanOrEqual(maxRunCostUsd);
    process.stdout.write(
      `ACCESSWRIGHT_LIVE_USAGE=${JSON.stringify({
        model: modelId,
        attempts: result.attempts,
        inputTokens: snapshot.inputTokens,
        outputTokens: snapshot.outputTokens,
        costUsd: snapshot.spentUsd,
      })}\n`,
    );
  },
  60_000,
);
