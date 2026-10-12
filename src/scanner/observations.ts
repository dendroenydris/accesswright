import { z } from "zod";
import { ScanConditionSchema } from "./browser-facts.js";
import { SourceIndexEntrySchema } from "./source-index.js";
import { SourceLocationSchema, ViolationSchema } from "../types/schemas.js";
import type { PageVerificationState } from "../verifier/per-patch.js";

export const AccessibleFactSchema = z.object({
  id: z.string(), role: z.string().nullable(), name: z.string(), text: z.string(),
  interactive: z.boolean(), headingLevel: z.number().int().positive().optional(),
  protectedContent: z.boolean().optional(),
  volatileText: z.boolean().optional(),
}).strict();
const artifactName = z.string().regex(/^[a-zA-Z0-9_-]+\.png$/);
export const RenderedContextSchema = z.object({
  nodeId: z.string().optional(),
  target: z.array(z.string()),
  source: SourceLocationSchema.nullable(),
  mapping: z.enum(["direct", "ancestor", "unmapped"]),
  pageTitle: z.string(), surroundingText: z.string(), imageCaption: z.string().nullable(),
  linkTarget: z.string().nullable(), screenshot: artifactName.nullable(),
  foreground: z.string(), background: z.string().nullable(), contrastTarget: z.number(),
  palette: z.array(z.object({ className: z.string(), color: z.string() }).strict()),
}).strict();
export type RenderedContext = z.infer<typeof RenderedContextSchema>;

export const BrowserObservationSchema = z.object({
  route: z.string().startsWith("/"), condition: ScanConditionSchema,
  checkerVersion: z.string().min(1).optional(),
  ibmCheckerVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/).optional(),
  documentLanguage: z.string().optional(), documentTitle: z.string().optional(),
  sourceIndex: z.array(SourceIndexEntrySchema).max(20000).optional(),
  violations: z.array(ViolationSchema), incomplete: z.array(ViolationSchema),
  aria: z.array(AccessibleFactSchema), ariaTree: z.string(),
  probeFailures: z.array(z.string()), probeUnavailable: z.array(z.string()),
  contexts: z.array(RenderedContextSchema), screenshot: artifactName,
  darkMediaDetected: z.boolean(),
  sourceFiles: z.array(z.string()).default([]),
}).strict();
export type BrowserObservation = z.infer<typeof BrowserObservationSchema>;

export function observationsToState(observations: readonly BrowserObservation[]): PageVerificationState {
  return {
    violations: observations.flatMap(item => item.violations),
    incomplete: observations.flatMap(item => item.incomplete),
    aria: observations.flatMap(item => item.aria),
    probeFailures: observations.flatMap(item => item.probeFailures),
  };
}
