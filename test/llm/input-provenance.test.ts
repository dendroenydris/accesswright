import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { LlmClient } from "../../src/llm/client.js";
import { DurableBudgetProvider } from "../../src/llm/durable-provider.js";
import { DurableSpendLedger } from "../../src/llm/durable-spend.js";
import { createJsonlLlmObserver } from "../../src/llm/run-record.js";
import type { LlmCallRequest, LlmImage } from "../../src/llm/types.js";
import { RunRecordSchema } from "../../src/tracer/run-record.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";

it("binds ledger and trace hashes to system instructions, image bytes, media types and image order", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-input-provenance-"));
  try {
    const request: LlmCallRequest = { taskType: "fixture", model: { provider: "openai", id: "fixture-model" }, prompt: "private-source-marker", maxOutputTokens: 100 };
    const first: LlmImage = { mediaType: "image/png", data: Uint8Array.from([0, 1]) };
    const second: LlmImage = { mediaType: "image/png", data: Uint8Array.from([0, 2]) };
    const requests: LlmCallRequest[] = [request, { ...request, system: "first" }, { ...request, system: "second" },
      { ...request, images: [first] }, { ...request, images: [second] }, { ...request, images: [{ ...first, mediaType: "image/jpeg" }] },
      { ...request, images: [first, second] }, { ...request, images: [second, first] }, { ...request }];
    const ledgerPath = join(root, "spend.json"), tracePath = join(root, "run.jsonl");
    const ledger = await DurableSpendLedger.initialize(ledgerPath, { maxUsd: 1, history: [] });
    const reserve = vi.spyOn(ledger, "reserve");
    const provider = new FakeLlmProvider(requests.map(() => ({ object: { ok: true }, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.00002 } })));
    const client = new LlmClient(new DurableBudgetProvider(provider, { ledger, model: request.model, maxInputTokens: 1000,
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } }), createJsonlLlmObserver(tracePath));
    for (const input of requests) expect((await client.callStructured(input, z.object({ ok: z.boolean() }))).status).toBe("accepted");
    const trace = await readFile(tracePath, "utf8");
    const hashes = trace.trim().split("\n").map(line => RunRecordSchema.parse(JSON.parse(line) as unknown).metadata?.promptHash);
    expect(new Set(hashes).size).toBe(8);
    expect(hashes[0]).toBe(hashes[8]);
    expect(reserve.mock.calls.map(call => call[2])).toEqual(hashes);
    expect(trace).not.toContain(request.prompt);
    expect(await readFile(ledgerPath, "utf8")).not.toContain(request.prompt);
  } finally { await rm(root, { recursive: true, force: true }); }
});
