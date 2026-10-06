import { appendFile } from "node:fs/promises";

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
}
