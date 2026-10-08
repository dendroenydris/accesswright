import { z } from "zod";

import {
  criterionReference,
  referenceEdition,
  referenceSource,
} from "../planner/references.js";
import { RunReportSchema } from "./report.js";
import type { RunReport } from "./report.js";

const commitSchema = z.object({
  id: z.string().min(1),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();

export interface EvidenceReportOptions {
  commits: Array<z.infer<typeof commitSchema>>;
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("`", "&#96;")
    .replace(/[\r\n]/g, " ");
}

const manualReviewAreas = [
  "Meaning and semantic appropriateness of alternative text and accessible names require manual review.",
  "Keyboard and screen-reader behavior outside the instrumented routes and states.",
  "Timing, motion, media alternatives, cognitive requirements, and user-flow accessibility not covered by the automated checker.",
  "Legal applicability, organizational process requirements, and any claim of WCAG / EN 301 549 / EAA conformity.",
] as const;

export function renderEvidenceReport(
  input: RunReport,
  rawOptions: EvidenceReportOptions,
): string {
  const report = RunReportSchema.parse(input);
  const commits = z.array(commitSchema).parse(rawOptions.commits);
  const commitById = new Map(commits.map(item => [item.id, item.commit]));
  const accepted = report.final.acceptedFixIds;
  if (
    new Set(commits.map(item => item.id)).size !== commits.length ||
    commits.length !== accepted.length ||
    accepted.some(id => !commitById.has(id))
  ) {
    throw new Error("Accepted fix IDs and evidence commit metadata do not agree");
  }

  const scan = report.scanSummary;
  const incompleteCount =
    scan?.rules.reduce((sum, rule) => sum + rule.incomplete, 0) ?? 0;
  const review = report.outcomes.filter(outcome =>
    ["needs-human", "rejected", "dropped"].includes(outcome.status),
  );

  const lines = [
    "# Accesswright evidence report",
    "",
    `Run: ${report.startedAt} → ${report.finishedAt}. Final gate: **${report.status}**.`,
    "This report summarizes automated technical evidence. It is not a legal compliance certification and does not establish that all WCAG or EN 301 549 requirements are met.",
    "",
    "## Found / fixed / remaining",
    "",
    "| Rule | WCAG | EN 301 549 | Found | Fixed | Remaining | Inconclusive |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: |",
    ...(scan?.rules.map(rule => {
      const fixed = Math.max(0, rule.before - rule.remaining);
      return `| ${escape(rule.ruleId)} | ${escape(rule.criterion)} | ${rule.en301549 ?? "not mapped"} | ${rule.before} | ${fixed} | ${rule.remaining} | ${rule.incomplete} |`;
    }) ?? []),
    ...(scan?.rules.length ? [] : ["| not measured | not measured | not mapped | 0 | 0 | 0 | 0 |"]),
    "",
    "### Verified fix groups",
    "",
    "| Fix group | Rule | WCAG | EN 301 549 | Isolated verification commit |",
    "| --- | --- | --- | --- | --- |",
    ...report.outcomes
      .filter(outcome => outcome.status === "verified" && commitById.has(outcome.id))
      .map(outcome => `| ${escape(outcome.id)} | ${escape(outcome.ruleId)} | ${escape(outcome.criterion)} | ${criterionReference(outcome.criterion).en301549 ?? "not mapped"} | \`${commitById.get(outcome.id)}\` |`),
    ...(accepted.length ? [] : ["| none | — | — | — | — |"]),
    "",
    "## Needs review",
    "",
    `Inconclusive checker findings: ${incompleteCount}. Unavailable dynamic interaction probes: ${scan?.probeUnavailable ?? 0}.`,
    "",
    ...review.map(outcome => `- ${escape(outcome.ruleId)} / ${escape(outcome.criterion)}: ${outcome.status}${outcome.reason ? ` — ${escape(outcome.reason)}` : ""}.`),
    ...(review.length ? [] : ["- No repair task was explicitly escalated by this run."]),
    "",
    "## Not automatically testable",
    "",
    ...manualReviewAreas.map(item => `- ${item}`),
    "",
    "## Scope",
    "",
    `Routes: ${scan?.routes.map(escape).join(", ") || "not recorded"}.`,
    `Conditions: ${scan?.conditions.map(escape).join(", ") || "not recorded"}.`,
    `axe-core: ${scan?.checkerVersions.map(escape).join(", ") || "not recorded"}.`,
    `Source mapping: ${scan ? `${scan.sourceMapping.mapped}/${scan.sourceMapping.total}` : "not recorded"}.`,
    `Coverage: ${scan?.coverageComplete ? "complete for the recorded baseline route/condition pairs" : "incomplete or not recorded"}.`,
    `Production checks: ${report.checks.map(check => `${check.check}: ${check.status}`).join(", ") || "none recorded"}.`,
    "",
    `Technical cross-reference edition: ${referenceEdition}. Source: ${referenceSource}. Criteria without a reviewed mapping are left unmapped.`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}
