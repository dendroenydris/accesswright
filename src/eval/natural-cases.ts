#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

import { defaults } from "../config.js";
import { isMainModule } from "../entrypoint.js";
import { getRuleDefinition } from "../planner/rules.js";
import { ScanConditionSchema } from "../scanner/browser-facts.js";
import { BrowserObservationSchema } from "../scanner/observations.js";
import type { BrowserObservation } from "../scanner/observations.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const finding = z.object({
  ruleId: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/),
  impact: z.enum(["minor", "moderate", "serious", "critical"]).nullable(),
  targetDigest: digest, sourceDigest: digest.nullable(),
}).strict();
const scopeSchema = z.object({
  schemaVersion: z.literal(1), protocolDigest: digest, repositoryDigest: digest,
  baseSha: z.string().regex(/^[a-f0-9]{40}$/), implementationDigest: digest,
  observedAt: z.iso.datetime(), checkerVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/),
  ibmCheckerVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/).optional(),
}).strict();
export const NaturalScanMetadataSchema = scopeSchema.extend({
  pages: z.array(z.object({
    routeDigest: digest, condition: ScanConditionSchema,
    violations: z.array(finding).max(defaults.naturalCasesMaxFindings),
    incompleteCount: z.number().int().nonnegative().max(defaults.naturalCasesMaxFindings),
  }).strict()).max(defaults.maxRoutes * 3),
}).strict().refine(data => data.pages.reduce((n, page) => n + page.violations.length, 0) <= defaults.naturalCasesMaxFindings,
  "Too many natural findings");

function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

/** Project transient baseline observations into metadata before retaining anything. No private page facts leave this function. */
export function naturalScanMetadata(scope: unknown, observations: readonly BrowserObservation[]) {
  const metadata = scopeSchema.parse(scope);
  const pages = observations.map(input => {
    const page = BrowserObservationSchema.parse(input);
    if (page.checkerVersion !== metadata.checkerVersion || page.ibmCheckerVersion !== metadata.ibmCheckerVersion || page.violations.some(item =>
      item.route !== page.route || (item.condition !== undefined && item.condition !== page.condition))) throw new Error("Conflicting baseline observation");
    return { routeDigest: hash(page.route), condition: page.condition, incompleteCount: page.incomplete.length,
      violations: page.violations.map(item => ({ ruleId: item.ruleId, impact: item.impact,
        targetDigest: hash(item.target), sourceDigest: item.source === null ? null : hash(item.source) })) };
  });
  return NaturalScanMetadataSchema.parse({ ...metadata, pages });
}

/** Case counts and blank review rows are supplied metadata, not measured repairs or authenticated human reviews. */
export function collectNaturalCases(input: unknown) {
  const data = NaturalScanMetadataSchema.parse(input);
  const pageIds = data.pages.map(page => `${page.routeDigest}|${page.condition}`);
  if (new Set(pageIds).size !== pageIds.length) throw new Error("Repeated route/condition observation");
  const pages = [...data.pages].sort((a, b) => `${a.routeDigest}|${a.condition}`.localeCompare(`${b.routeDigest}|${b.condition}`));
  const cases = pages.flatMap(page => {
    const occurrences = new Map<string, number>();
    return [...page.violations].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))).map(item => {
      const identity = hash([data.repositoryDigest, data.baseSha, page.routeDigest, page.condition, item.ruleId, item.targetDigest, item.sourceDigest]);
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      const rule = getRuleDefinition(item.ruleId);
      return { caseId: hash([identity, occurrence]), ...item, routeDigest: page.routeDigest, condition: page.condition,
        occurrence, criterion: rule.criterion === "unknown" ? null : rule.criterion, en301549: rule.en301549,
        referenceEdition: rule.referenceEdition, repairRoute: rule.route };
    });
  });
  return { schemaVersion: 1 as const, track: "N" as const, provenance: "supplied-baseline-metadata" as const,
    protocolDigest: data.protocolDigest, repositoryDigest: data.repositoryDigest, baseSha: data.baseSha,
    implementationDigest: data.implementationDigest, observedAt: data.observedAt, checkerVersion: data.checkerVersion,
    ...(data.ibmCheckerVersion === undefined ? {} : { ibmCheckerVersion: data.ibmCheckerVersion }),
    scanDigest: hash({ ...data, pages }), observedPages: pages.length,
    incompleteFindings: pages.reduce((n, page) => n + page.incompleteCount, 0), cases,
    labelingSheet: { targetAcceptedPatches: defaults.naturalAuditTargetPatches, plannedRaters: 1,
      checklist: ["Confirm the exact accepted patch and pinned baseline in the private verifier evidence.",
        "Check the target is resolved without new violations or removed/hidden content and controls.",
        "Review semantic accuracy, page relevance and behavior, including image meaning where applicable.",
        "Exercise keyboard navigation and focus; record a screen-reader spot check separately."],
      rows: cases.map(item => ({ caseId: item.caseId, patchDigest: null, reviewerDigest: null, reviewedAt: null,
        verifierEvidenceDigest: null, targetResolved: null, noNewViolations: null, contentPreserved: null,
        semanticCorrect: null, keyboardChecked: null, screenReaderSpotChecked: null })) },
  };
}

export async function runNaturalCasesCli(args: readonly string[]) {
  if (args.length !== 2 || args[0] !== "--scan" || !args[1] || !isAbsolute(args[1])) throw new Error("Expected --scan <absolute metadata JSON path>");
  const file = await open(args[1], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > defaults.naturalCasesInputMaxBytes) throw new Error("Natural scan input must be a bounded regular file");
    const bytes = Buffer.alloc(defaults.naturalCasesInputMaxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const part = await file.read(bytes, size, bytes.length - size, null);
      if (part.bytesRead === 0) break;
      size += part.bytesRead;
    }
    if (size > defaults.naturalCasesInputMaxBytes) throw new Error("Natural scan input exceeds size limit");
    return collectNaturalCases(JSON.parse(bytes.subarray(0, size).toString("utf8")) as unknown);
  } finally { await file.close(); }
}

if (await isMainModule(import.meta.url)) {
  runNaturalCasesCli(process.argv.slice(2)).then(result => { process.stdout.write(JSON.stringify(result) + "\n"); }).catch(() => {
    process.stderr.write("Natural case collection failed; check the bounded baseline metadata\n");
    process.exitCode = 2;
  });
}
