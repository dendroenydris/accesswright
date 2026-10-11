import { appendFile } from "node:fs/promises";
import { ROOT_CONTEXT, SpanStatusCode } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { AlwaysOnSampler, NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";

import { z } from "zod";

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const metadataSchema = z.record(z.string(), scalarSchema).superRefine((value, context) => {
  for (const key of Object.keys(value)) {
    if (/(api[_-]?key|token|secret|password|credential)/i.test(key)) {
      context.addIssue({
        code: "custom",
        message: `Secret-like metadata key is not allowed: ${key}`,
      });
    }
  }
});

export const RunRecordSchema = z
  .object({
    timestamp: z.string().datetime(),
    step: z.string().min(1),
    status: z.enum(["ok", "rejected", "error", "skipped"]),
    durationMs: z.number().nonnegative().optional(),
    metadata: metadataSchema.optional(),
    model: z
      .object({
        provider: z.string().min(1),
        id: z.string().min(1),
        reasoningEffort: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        costUsd: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RunRecord = z.infer<typeof RunRecordSchema>;

export async function appendRunRecord(path: string, record: RunRecord): Promise<void> {
  const validated = RunRecordSchema.parse(record);
  await appendFile(path, `${JSON.stringify(validated)}\n`, "utf8");
  const specific = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const configured = specific || process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!configured) return;
  try {
    const endpoint = new URL(configured);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("Invalid trace endpoint");
    if (!specific) endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/v1/traces`;
    const provider = new NodeTracerProvider({ sampler: new AlwaysOnSampler(), spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({ url: endpoint.href }))] });
    try {
      const end = Date.parse(validated.timestamp);
      // Arbitrary metadata may contain private page text or source paths.
      const span = provider.getTracer("accesswright").startSpan(validated.step, {
        startTime: end - (validated.durationMs ?? 0),
        attributes: {
          "accesswright.status": validated.status,
          ...(validated.model === undefined ? {} : {
            "llm.provider": validated.model.provider, "llm.model": validated.model.id,
            ...(validated.model.reasoningEffort === undefined ? {} : { "llm.reasoning_effort": validated.model.reasoningEffort }),
          }),
          ...(validated.usage?.inputTokens === undefined ? {} : { "llm.input_tokens": validated.usage.inputTokens }),
          ...(validated.usage?.outputTokens === undefined ? {} : { "llm.output_tokens": validated.usage.outputTokens }),
          ...(validated.usage?.costUsd === undefined ? {} : { "llm.cost_usd": validated.usage.costUsd }),
          ...(typeof validated.metadata?.promptHash === "string" && /^[a-f0-9]{64}$/.test(validated.metadata.promptHash) ? { "llm.prompt_hash": validated.metadata.promptHash } : {}),
        },
      }, ROOT_CONTEXT);
      span.setStatus({ code: validated.status === "error" || validated.status === "rejected" ? SpanStatusCode.ERROR : validated.status === "ok" ? SpanStatusCode.OK : SpanStatusCode.UNSET });
      span.end(end);
      await provider.forceFlush();
    } finally { await provider.shutdown(); }
  } catch {
    // Collector failure must not replace local evidence or verifier decisions.
    await appendFile(path, `${JSON.stringify({ timestamp: new Date().toISOString(), step: "trace-export", status: "error", metadata: { step: validated.step } })}\n`, "utf8");
  }
}
