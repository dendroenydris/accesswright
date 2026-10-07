import { z } from "zod";
import type { RepairResult } from "../core/repair.js";
import type { ProductionCheckResult } from "../runner/production-checks.js";
import type { BudgetLedger } from "../llm/budget.js";

export const RunReportSchema = z.object({
  schemaVersion: z.literal(1), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), durationMs: z.number().nonnegative(),
  status: z.enum(["verified", "blocked"]), applied: z.boolean(), fixed: z.number().int().nonnegative(), rejected: z.number().int().nonnegative(),
  needsHuman: z.number().int().nonnegative(), ignored: z.number().int().nonnegative(), attempts: z.number().int().nonnegative(),
  providerVerification: z.enum(["not-run", "fake-provider", "provider-api"]), unknownUsage: z.boolean(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), spentUsd: z.number().nonnegative() }).strict(),
  checks: z.array(z.object({ check: z.enum(["build", "typecheck", "lint", "tests"]), available: z.boolean(), status: z.enum(["passed", "failed", "unavailable"]), durationMs: z.number().nonnegative(), exitCode: z.number().nullable(), failureIds: z.array(z.string()) }).strict()),
  outcomes: z.array(z.object({ id: z.string(), ruleId: z.string(), criterion: z.string(), route: z.string(), status: z.enum(["verified", "rejected", "needs-human", "ignored", "dropped"]), reason: z.string().nullable() }).strict()),
  final: z.object({ acceptedFixIds: z.array(z.string()), droppedFixIds: z.array(z.string()), failures: z.array(z.object({ check: z.enum(["build", "typecheck", "lint", "tests", "violations"]), id: z.string() }).strict()) }).strict(),
}).strict();
export type RunReport = z.infer<typeof RunReportSchema>;

export function makeRunReport(input: {
  result: RepairResult;
  startedAt: string;
  finishedAt: string;
  applied: boolean;
  checks: readonly ProductionCheckResult[];
  usage: Pick<ReturnType<BudgetLedger["snapshot"]>, "spentUsd" | "inputTokens" | "outputTokens">;
  providerVerification: RunReport["providerVerification"];
  unknownUsage?: boolean;
}): RunReport {
  const { status, fixed, rejected, needsHuman, ignored, attempts, final, outcomes } = input.result;
  return RunReportSchema.parse({ status, fixed, rejected, needsHuman, ignored, attempts, final, outcomes,
    schemaVersion: 1, startedAt: input.startedAt, finishedAt: input.finishedAt,
    durationMs: Date.parse(input.finishedAt) - Date.parse(input.startedAt), applied: input.applied,
    providerVerification: input.providerVerification, unknownUsage: input.unknownUsage ?? false, usage: { spentUsd: input.usage.spentUsd, inputTokens: input.usage.inputTokens, outputTokens: input.usage.outputTokens },
    checks: input.checks.map(({ check, available, status, durationMs, exitCode, failureIds }) => ({ check, available, status, durationMs, exitCode, failureIds })),
  });
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "&#124;").replaceAll("`", "&#96;").replaceAll("@", "@\u200b").replace(/[\r\n]/g, " ");
}

export function renderPullRequestReport(input: RunReport): string {
  const report = RunReportSchema.parse(input);
  const lines = [
    "## Accessibility repair verification", "",
    `${report.fixed} verified fix groups; ${report.rejected} rejected or dropped; ${report.needsHuman} requiring human attention.`, "",
    `Final gate: **${report.status}**. Provider evidence: **${report.providerVerification}**.`,
    `Recorded usage: ${report.usage.inputTokens} input tokens, ${report.usage.outputTokens} output tokens; USD ${report.usage.spentUsd.toFixed(6)}${report.unknownUsage ? " plus unreconciled usage; further paid calls blocked" : ""}.`, "",
    "### Production checks", "",
    "| Check | Status |", "| --- | --- |",
    ...report.checks.map(check => `| ${check.check} | ${check.status} |`), "",
    "### Fix decisions", "",
    "| Rule | WCAG criterion | Decision |", "| --- | --- | --- |",
    ...report.outcomes.map(outcome => `| ${escape(outcome.ruleId)} | ${escape(outcome.criterion)} | ${outcome.status}${outcome.reason ? `: ${escape(outcome.reason)}` : ""} |`), "",
    "### Human review", "",
    "Review the source diff, accessible names, informative images, keyboard behavior, and visual evidence. A passing automated check does not establish semantic correctness or coverage of every accessibility requirement.", "",
    "Not a legal compliance certification. Missing checks are reported as unavailable, not passed.", "",
    "<!-- accesswright:verified-report:v1 -->",
  ];
  return `${lines.join("\n")}\n`;
}
