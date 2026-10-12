import { z } from "zod";
import { criterionReference } from "../planner/references.js";
import { getRuleDefinition } from "../planner/rules.js";
import type { BrowserObservation } from "../scanner/observations.js";
import type { Violation } from "../types/schemas.js";

const count = z.number().int().nonnegative();
export const ScanSummarySchema = z.object({
  countUnit: z.literal("finding per route and scan condition"),
  routes: z.array(z.string()), conditions: z.array(z.string()), checkerVersions: z.array(z.string()),
  coverageComplete: z.boolean(), missingObservations: z.array(z.string()),
  sourceMapping: z.object({ mapped: count, total: count }).strict(),
  probeUnavailable: count,
  keyboard: z.object({ expectedObservations: count, observedObservations: count, unavailableObservations: count, repeatedSequences: count, unreachedControls: count }).strict().optional(),
  rules: z.array(z.object({ ruleId: z.string(), criterion: z.string(), en301549: z.string().nullable(), before: count, remaining: count, incomplete: count }).strict()),
}).strict();
export type ScanSummary = z.infer<typeof ScanSummarySchema>;

/** Persist aggregate evidence, not HTML, selectors, screenshots or source snippets. */
export function summarizeScans(before: readonly BrowserObservation[], after: readonly BrowserObservation[], development: readonly BrowserObservation[]): ScanSummary {
  const identity = (page: BrowserObservation) => `${page.route}|${page.condition}`;
  const afterKeys = new Set(after.map(identity));
  const missingObservations = before.filter(page => !afterKeys.has(identity(page))).map(identity).sort();
  const groups = new Map<string, ScanSummary["rules"][number]>();
  const add = (items: readonly Violation[], field: "before" | "remaining" | "incomplete") => {
    for (const item of items) {
      const definition = getRuleDefinition(item.ruleId);
      const group = groups.get(item.ruleId) ?? { ruleId: item.ruleId, criterion: definition.criterion, en301549: criterionReference(definition.criterion).en301549, before: 0, remaining: 0, incomplete: 0 };
      group[field] += 1;
      groups.set(item.ruleId, group);
    }
  };
  add(before.flatMap(page => page.violations), "before");
  add(after.flatMap(page => page.violations), "remaining");
  add(after.flatMap(page => page.incomplete), "incomplete");
  const mapped = development.flatMap(page => page.violations);
  const keyboardPages = after.filter(page => page.keyboard !== undefined);
  const expectedKeyboard = before.filter(page => page.keyboard !== undefined);
  return ScanSummarySchema.parse({ countUnit: "finding per route and scan condition",
    routes: [...new Set([...before, ...after].map(page => page.route))].sort(),
    conditions: [...new Set([...before, ...after].map(page => page.condition))].sort(),
    checkerVersions: [...new Set([...before, ...after].flatMap(page => [page.checkerVersion ?? "unknown", ...(page.ibmCheckerVersion ? [`ibm-equal-access@${page.ibmCheckerVersion}`] : [])]))].sort(),
    coverageComplete: before.length > 0 && missingObservations.length === 0,
    missingObservations, sourceMapping: { mapped: mapped.filter(item => item.source !== null).length, total: mapped.length },
    probeUnavailable: after.reduce((sum, page) => sum + page.probeUnavailable.length, 0),
    ...(keyboardPages.length === 0 && expectedKeyboard.length === 0 ? {} : { keyboard: {
      expectedObservations: expectedKeyboard.length, observedObservations: keyboardPages.length,
      unavailableObservations: expectedKeyboard.filter(page => !keyboardPages.some(item => identity(item) === identity(page))).length +
        keyboardPages.filter(page => page.keyboard?.forward.stop !== "document-boundary" || page.keyboard.reverse.stop !== "document-boundary").length,
      repeatedSequences: keyboardPages.reduce((n, page) => n + Number(page.keyboard?.forward.stop === "repeat") + Number(page.keyboard?.reverse.stop === "repeat"), 0),
      unreachedControls: keyboardPages.reduce((n, page) => n + (page.keyboard?.unreachedControls.length ?? 0), 0),
    } }),
    rules: [...groups.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
  });
}
