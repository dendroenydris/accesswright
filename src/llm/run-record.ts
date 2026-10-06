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
