import { createHash } from "node:crypto";
import { z } from "zod";
import { defaults } from "../config.js";
import { isSourcePath, PatchSchema } from "../types/schemas.js";
import { RunReportSchema } from "../reporter/report.js";

export const HostedCandidateSchema = z.object({ report: RunReportSchema, patches: z.array(PatchSchema).max(defaults.maxTasks) }).strict();
export type HostedCandidate = z.infer<typeof HostedCandidateSchema>;
export const HostedCandidateReceiptSchema = z.object({ status: z.literal("recorded"), runId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), candidateDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** Transfer identity only; this digest is never a trusted verification receipt. */
export function hostedCandidateDigest(candidate: HostedCandidate): string {
  return createHash("sha256").update(JSON.stringify(HostedCandidateSchema.parse(candidate))).digest("hex");
}

export const HostedRepairContextSchema = z.object({
  component: z.object({ file: z.string().refine(isSourcePath), line: z.number().int().positive(), column: z.number().int().positive(), sourceExcerpt: z.string().max(12_000) }).strict(),
  callSites: z.array(z.object({ file: z.string().refine(isSourcePath), line: z.number().int().positive(), column: z.number().int().positive(), source: z.string().max(2_000) }).strict()).max(defaults.maxContextFiles),
  page: z.object({ title: z.string().max(500).nullable(), surroundingText: z.string().max(4_000), caption: z.string().max(1_000).nullable(), linkTarget: z.string().max(2_000).nullable() }).strict(),
  screenshotPath: z.string().max(256).nullable(),
}).strict();

const imageSchema = z.object({
  mediaType: z.literal("image/png"),
  data: z.string().min(12).max(Math.ceil(defaults.maxImageBytes / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/),
}).strict().refine(image => {
  const bytes = Buffer.from(image.data, "base64");
  return bytes.length <= defaults.maxImageBytes && bytes.toString("base64") === image.data &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}, "Image evidence must be bounded PNG bytes");

export const HostedPatchEvidenceSchema = z.object({
  images: z.array(imageSchema).max(defaults.hostedMaxImages).default([]),
  feedback: z.string().max(defaults.hostedMaxFeedbackChars).nullable().default(null),
}).strict();

export const HostedPatchRequestSchema = HostedPatchEvidenceSchema.extend({ task: z.unknown(), context: z.unknown() });
const usageSchema = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), costUsd: z.number().finite().nonnegative() }).strict();
export const HostedPatchResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), patch: PatchSchema, usage: usageSchema }).strict(),
  z.object({ status: z.literal("rejected"), reason: z.string().max(defaults.hostedMaxFeedbackChars), usage: usageSchema.nullable() }).strict(),
]);
