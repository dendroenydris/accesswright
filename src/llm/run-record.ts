import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { LlmCallObserver } from "./client.js";
import { appendRunRecord } from "../tracer/run-record.js";

export function createJsonlLlmObserver(path: string): LlmCallObserver {
  return async (event) => {
    await appendRunRecord(path, {
      timestamp: new Date().toISOString(),
      step: "llm",
      status:
        event.status === "ok"
          ? "ok"
          : event.status === "rejected"
            ? "rejected"
            : "error",
      metadata: {
        taskType: event.taskType,
        promptHash: event.promptHash,
      },
      model: {
        provider: event.model.provider,
        id: event.model.id,
        ...(event.model.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: event.model.reasoningEffort }),
      },
      ...(event.usage === undefined
        ? {}
        : {
            usage: {
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              costUsd: event.usage.costUsd,
            },
          }),
    });
  };
}

export function createJsonlLlmRunObserver(evidenceRoot: string) {
  if (!isAbsolute(evidenceRoot)) throw new Error("LLM run evidence root must be absolute");
  return async (runId: string, event: Parameters<LlmCallObserver>[0]): Promise<void> => {
    const directory = join(evidenceRoot, z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).parse(runId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await createJsonlLlmObserver(join(directory, "run.jsonl"))(event);
  };
}
