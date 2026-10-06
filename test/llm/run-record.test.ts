import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { LlmClient } from "../../src/llm/client.js";
import { createJsonlLlmObserver } from "../../src/llm/run-record.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";

describe("LLM run recording", () => {
  it("records model, usage, cost, and prompt hash without raw prompt or secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "accesswright-llm-record-"));
    const path = join(directory, "run.jsonl");
    const provider = new FakeLlmProvider([
      {
        object: { value: "ok" },
        usage: { inputTokens: 123, outputTokens: 45, costUsd: 0.0123 },
      },
    ]);
    const client = new LlmClient(provider, createJsonlLlmObserver(path));

    await client.callStructured(
      {
        taskType: "semantic-repair",
        model: {
          provider: "openai",
          id: "gpt-test",
          reasoningEffort: "high",
          apiKeyEnv: "OPENAI_API_KEY",
        },
        prompt: "PRIVATE SOURCE PROMPT",
        maxOutputTokens: 512,
      },
      z.object({ value: z.string() }),
    );

    const raw = await readFile(path, "utf8");
    const record = JSON.parse(raw.trim()) as {
      step: string;
      status: string;
      metadata: Record<string, unknown>;
      model: Record<string, unknown>;
      usage: Record<string, unknown>;
    };

    expect(record).toMatchObject({
      step: "llm",
      status: "ok",
      metadata: {
        taskType: "semantic-repair",
      },
      model: {
        provider: "openai",
        id: "gpt-test",
        reasoningEffort: "high",
      },
      usage: {
        inputTokens: 123,
        outputTokens: 45,
        costUsd: 0.0123,
      },
    });
    expect(record.metadata.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(raw).not.toContain("PRIVATE SOURCE PROMPT");
    expect(raw).not.toContain("OPENAI_API_KEY");
  });

  it("records schema rejection as rejected with billed usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "accesswright-llm-record-"));
    const path = join(directory, "run.jsonl");
    const provider = new FakeLlmProvider([
      {
        object: { value: 42 },
        usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.001 },
      },
    ]);
    const client = new LlmClient(provider, createJsonlLlmObserver(path));

    await client.callStructured(
      {
        taskType: "semantic-repair",
        model: { provider: "openai", id: "gpt-test" },
        prompt: "prompt",
        maxOutputTokens: 512,
      },
      z.object({ value: z.string() }),
    );

    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw.trim())).toMatchObject({
      status: "rejected",
      usage: { costUsd: 0.001 },
    });
  });
});
