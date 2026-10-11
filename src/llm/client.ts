import { createHash } from "node:crypto";

import type { z } from "zod";

import type {
  LlmCallRequest,
  LlmProvider,
  LlmUsage,
} from "./types.js";
import { LlmStructuredOutputError } from "./errors.js";
import { hashLlmInput } from "./input-hash.js";

export type StructuredCallResult<T> =
  | {
      status: "accepted";
      value: T;
      usage: LlmUsage;
    }
  | {
      status: "rejected";
      reason: "schema" | "provider";
      message: string;
      usage?: LlmUsage;
    };

export interface LlmCallEvent {
  taskType: string;
  promptHash: string;
  model: {
    provider: string;
    id: string;
    reasoningEffort?: string;
  };
  status: "ok" | "rejected" | "error";
  usage?: LlmUsage;
}

export type LlmCallObserver = (
  event: LlmCallEvent,
) => Promise<void> | void;

export class LlmClient {
  private readonly provider: LlmProvider;
  private readonly observer: LlmCallObserver | undefined;

  constructor(provider: LlmProvider, observer?: LlmCallObserver) {
    this.provider = provider;
    this.observer = observer;
  }

  async callStructured<T>(
    request: LlmCallRequest,
    validationSchema: z.ZodType<T>,
    providerSchema: z.ZodType<unknown> = validationSchema,
  ): Promise<StructuredCallResult<T>> {
    const promptHash = hashLlmInput(request);
    const eventBase = {
      taskType: request.taskType,
      promptHash,
      model: {
        provider: request.model.provider,
        id: request.model.id,
        ...(request.model.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: request.model.reasoningEffort }),
      },
    };

    let response;
    try {
      response = await this.provider.generateObject(request, providerSchema);
    } catch (error: unknown) {
      if (error instanceof LlmStructuredOutputError) {
        await this.observer?.({
          ...eventBase,
          status: "rejected",
          ...(error.usage === undefined ? {} : { usage: error.usage }),
        });
        return {
          status: "rejected",
          reason: "schema",
          message: error.message,
          ...(error.usage === undefined ? {} : { usage: error.usage }),
        };
      }
      await this.observer?.({
        ...eventBase,
        status: "error",
      });
      return {
        status: "rejected",
        reason: "provider",
        message: `Provider call failed; diagnostic ${createHash("sha256").update(error instanceof Error ? error.message : String(error)).digest("hex").slice(0, 16)}`,
      };
    }

    const parsed = validationSchema.safeParse(response.object);
    if (!parsed.success) {
      await this.observer?.({
        ...eventBase,
        status: "rejected",
        usage: response.usage,
      });
      return {
        status: "rejected",
        reason: "schema",
        message: parsed.error.issues
          .map((issue) => issue.message)
          .join("; "),
        usage: response.usage,
      };
    }

    await this.observer?.({
      ...eventBase,
      status: "ok",
      usage: response.usage,
    });
    return {
      status: "accepted",
      value: parsed.data,
      usage: response.usage,
    };
  }
}
