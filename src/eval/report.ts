import { z } from "zod";
import { LlmModelConfigSchema } from "../types/schemas.js";
import { RunReportSchema } from "../reporter/report.js";
import { EvalSystemSchema, OperatorSchema, experimentalEvalSystems } from "./protocol.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
export const CaseScoreSchema = z.object({ id: digest, operator: OperatorSchema, checkerAccepted: z.boolean(), semanticallyCorrect: z.boolean(), correctlyFixed: z.boolean() }).strict().refine(
  item => item.correctlyFixed === (item.checkerAccepted && item.semanticallyCorrect), "Correctness requires both the real checker and frozen semantics",
);
export const EvalCellSchema = z.object({
  schemaVersion: z.literal(1), protocolDigest: digest, implementationDigest: digest,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), sha: z.string().regex(/^[a-f0-9]{40}$/),
  corpus: z.enum(["public-nextjs", "controlled-fixtures"]), split: z.enum(["dev", "test"]), seed: count, batch: count,
  system: EvalSystemSchema, providerEvidence: z.enum(["not-run", "fake-provider", "provider-api"]), model: LlmModelConfigSchema,
  providerMode: z.enum(["none", "fake", "live"]),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), durationMs: z.number().finite().nonnegative(),
  status: z.enum(["completed", "blocked", "unsupported"]), reason: z.string().nullable(),
  cases: z.array(CaseScoreSchema), exclusions: z.array(z.object({ id: digest, reason: z.string() }).strict()),
  verification: z.array(z.object({ taskId: z.string(), caseIds: z.array(digest), accepted: z.boolean(), check: z.string() }).strict()),
  usage: z.object({ spentUsd: z.number().finite().nonnegative(), inputTokens: count, outputTokens: count, unknownUsage: z.boolean() }).strict(),
  controls: z.object({ observed: count, changed: count, unexpectedEditedFiles: z.array(z.string()) }).strict().refine(value => value.changed <= value.observed),
  newViolations: count, report: RunReportSchema.nullable(),
  evidenceId: z.string().regex(/^repair-run-[A-Za-z0-9_-]+$/).nullable().default(null),
}).strict().refine(cell => cell.providerEvidence === "not-run" || (cell.providerEvidence === "fake-provider" && cell.providerMode === "fake") || (cell.providerEvidence === "provider-api" && cell.providerMode === "live"), "Provider transport provenance conflicts with the configured mode")
  .refine(cell => !experimentalEvalSystems.some(system => system === cell.system) || cell.providerMode === "fake", "Experimental results require fake-provider mode");
export type EvalCell = z.infer<typeof EvalCellSchema>;

function quantile(values: number[], percentile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] ?? null;
}
function rate(numerator: number, denominator: number): number | null { return denominator ? numerator / denominator : null; }

function pairedComparisons(cells: readonly EvalCell[]) {
  const families = [["B1", "A1", "A"], ["A", "B2"], ["A", "A-retrieval"], ["A", "A-tool-loop"]] as const;
  const scopes = new Map<string, EvalCell[]>();
  for (const cell of cells) {
    const key = `${cell.corpus}|${cell.split}|${cell.providerMode}`;
    const group = scopes.get(key) ?? []; group.push(cell); scopes.set(key, group);
  }
  return families.flatMap(systems => [...scopes.entries()].filter(([, group]) => systems.every(system => group.some(cell => cell.system === system))).map(([scope, group]) => {
    const observations = systems.map(system => new Map(group.filter(cell => cell.system === system && cell.status === "completed").flatMap(cell => cell.cases.map(item => [`${cell.repository.toLowerCase()}@${cell.sha}|${cell.seed}|${item.id}`, item] as const))));
    const matched = [...(observations[0]?.keys() ?? [])].filter(key => observations.every(observation => observation.has(key)));
    return { scope, systems: [...systems], pairedCaseOpportunities: matched.length, results: observations.map((observation, index) => {
      const values = matched.map(key => observation.get(key)).filter((value): value is z.infer<typeof CaseScoreSchema> => value !== undefined);
      const correct = values.filter(value => value.correctlyFixed).length;
      return { system: systems[index], eligibleCases: values.length, correctlyFixed: correct, checkerAccepted: values.filter(value => value.checkerAccepted).length, correctFixRate: rate(correct, values.length), unpairedCaseOpportunities: observation.size - values.length };
    }) };
  }));
}

/** Pure reconstruction from actual cells: duplicates and mixed protocols fail closed; fake and live results never pool. */
export function aggregateEvaluation(input: readonly unknown[]) {
  const cells = input.map(item => EvalCellSchema.parse(item));
  if (new Set(cells.map(item => JSON.stringify(item.model))).size > 1) throw new Error("Cannot pool different model configurations");
  if (new Set(cells.map(item => item.protocolDigest)).size > 1) throw new Error("Cannot pool different frozen protocols");
  if (new Set(cells.map(item => item.implementationDigest)).size > 1) throw new Error("Cannot pool different implementation revisions");
  const seenCells = new Set<string>(), seenCases = new Set<string>();
  const groups = new Map<string, EvalCell[]>();
  for (const cell of cells) {
    const prefix = `${cell.corpus}|${cell.split}|${cell.providerMode}|${cell.system}|${cell.repository.toLowerCase()}@${cell.sha}|${cell.seed}`;
    const key = `${prefix}|${cell.batch}`;
    if (seenCells.has(key)) throw new Error("Duplicate evaluation cell");
    seenCells.add(key);
    for (const item of cell.cases) {
      const caseKey = `${prefix}|${item.id}`;
      if (seenCases.has(caseKey)) throw new Error("Duplicate case/seed observation");
      seenCases.add(caseKey);
    }
    const groupKey = `${cell.corpus}|${cell.split}|${cell.providerMode}|${cell.system}`;
    const group = groups.get(groupKey) ?? []; group.push(cell); groups.set(groupKey, group);
  }
  const summaries = [...groups.values()].map(group => {
    const first = group[0]; if (!first) throw new Error("Empty evaluation group");
    const completed = group.filter(cell => cell.status === "completed");
    const cases = completed.flatMap(cell => cell.cases), verification = group.flatMap(cell => cell.verification);
    const correctlyFixed = cases.filter(item => item.correctlyFixed).length;
    const checkerAccepted = cases.filter(item => item.checkerAccepted).length;
    const rejected = verification.filter(item => !item.accepted).length;
    const gaming = verification.filter(item => !item.accepted && item.check === "aria-tree").length;
    const spentUsd = group.reduce((sum, cell) => sum + cell.usage.spentUsd, 0);
    return {
      corpus: first.corpus, split: first.split, system: first.system, providerEvidence: first.providerMode,
      providerCalledCells: group.filter(cell => cell.providerEvidence !== "not-run").length,
      repositories: [...new Set(group.map(cell => cell.repository))].sort(), seeds: [...new Set(group.map(cell => cell.seed))].sort((a,b) => a-b),
      completedCells: completed.length,
      blockedCells: group.filter(cell => cell.status === "blocked").length,
      unsupportedCells: group.filter(cell => cell.status === "unsupported").length,
      unmeasuredCases: group.filter(cell => cell.status !== "completed").reduce((sum, cell) => sum + cell.cases.length, 0),
      eligibleCases: cases.length, uniqueCases: new Set(cases.map(item => item.id)).size,
      operators: [...new Set(cases.map(item => item.operator))].sort(), checkerAccepted, correctlyFixed,
      falseFixes: cases.filter(item => item.checkerAccepted && !item.semanticallyCorrect).length,
      correctFixRate: rate(correctlyFixed, cases.length), checkerAcceptanceRate: rate(checkerAccepted, cases.length),
      candidateAttempts: verification.length, rejectedAttempts: rejected, gamingAttempts: gaming,
      regressionRate: rate(rejected, verification.length), gamingRate: rate(gaming, verification.length),
      cleanNodesObserved: group.reduce((sum,cell) => sum+cell.controls.observed,0), cleanNodesChanged: group.reduce((sum,cell) => sum+cell.controls.changed,0),
      unexpectedEditedFiles: [...new Set(group.flatMap(cell => cell.controls.unexpectedEditedFiles))].sort(),
      newViolations: group.reduce((sum,cell) => sum+cell.newViolations,0), spentUsd,
      inputTokens: group.reduce((sum,cell) => sum+cell.usage.inputTokens,0), outputTokens: group.reduce((sum,cell) => sum+cell.usage.outputTokens,0),
      unknownUsage: group.some(cell => cell.usage.unknownUsage), costPerCorrectFixUsd: correctlyFixed ? spentUsd/correctlyFixed : null,
      p50RunMs: quantile(group.map(cell => cell.durationMs),0.5), p95RunMs: quantile(group.map(cell => cell.durationMs),0.95),
    };
  });
  return { schemaVersion: 1 as const, protocolDigest: cells[0]?.protocolDigest ?? null, implementationDigest: cells[0]?.implementationDigest ?? null, groups: summaries, pairedComparisons: pairedComparisons(cells), cells: cells.map(({ repository, sha, split, system, seed, batch, status, reason }) => ({ repository, sha, split, system, seed, batch, status, reason })) };
}
export type EvaluationSummary = ReturnType<typeof aggregateEvaluation>;

export function renderEvaluationReport(summary: EvaluationSummary): string {
  const percentage = (value: number | null) => value === null ? "not measured" : `${(100*value).toFixed(1)}%`;
  return ["# Accesswright evaluation", "", `Protocol: ${summary.protocolDigest ?? "no observations"}. Implementation: ${summary.implementationDigest ?? "not measured"}.`, "",
    "This is an observation report, not a complete benchmark or a compliance certification. Compare the achieved repository/operator/case/seed coverage with the frozen target before drawing conclusions.", "",
    "The denominator is confirmed seeded case opportunities in completed cells, including unresolved repairs. Cases retained in blocked or unsupported cells are unmeasured, not failed repairs, and do not count toward valid unique case coverage. Non-triggering mutations and setup failures are recorded separately. Repeated seeds are not new independent source cases. Semantic correctness is exact preservation of the original rendered role, name, text, interaction category, and language; semantic equivalence is not inferred. B1 proposals receive no checker feedback; the same verifier is applied externally for scoring. Fake-provider results are integration evidence only.", "",
    "| System | Split / evidence | Measured cases / unique | Checker accepted | Correct | False fixes | Cost USD |", "| --- | --- | --- | --- | --- | --- | --- |",
    ...summary.groups.map(group => `| ${group.system} | ${group.split} / ${group.providerEvidence} | ${group.eligibleCases} / ${group.uniqueCases} | ${percentage(group.checkerAcceptanceRate)} | ${percentage(group.correctFixRate)} | ${group.falseFixes} | ${group.spentUsd.toFixed(6)}${group.unknownUsage ? " + unknown" : ""} |`), "",
    "The evidence column denotes the configured mode. A live-capable system can fix deterministic cases without calling a provider; actual API invocation is recorded per cell and remains in the same system denominator.", "",
    "## Paired comparison", "",
    "Only case/seed opportunities in completed cells from every system listed in a comparison enter its paired table. A rejected or unresolved repair in a completed cell remains in this denominator. Blocked baselines, setup failures and non-triggering injections are excluded, reported separately, and cannot be interpreted as matched outcomes. Experimental B2/retrieval/tool-loop groups are directional fake-provider harness evidence until separately authorized live acceptance.", "",
    ...summary.pairedComparisons.map(comparison => `${comparison.scope}: ${comparison.pairedCaseOpportunities} matched opportunities. ${comparison.results.map(result => `${result.system ?? "unknown"}: ${result.correctlyFixed}/${result.eligibleCases} correct; ${result.unpairedCaseOpportunities} unpaired opportunities`).join("; ")}.`), "",
    "## Coverage and controls", "",
    ...summary.groups.map(group => `${group.system} (${group.providerEvidence}, ${group.split}): ${group.repositories.length} observed repositories; operators ${group.operators.join(", ") || "none"}; seeds ${group.seeds.join(", ")}; ${group.completedCells} completed cells, ${group.blockedCells} blocked and ${group.unsupportedCells} unsupported; ${group.unmeasuredCases} unmeasured case opportunities. Costs, controls, candidate attempts and timings retain evidence from all cells. Clean-node changes ${group.cleanNodesChanged}/${group.cleanNodesObserved}; unexpected edited files ${group.unexpectedEditedFiles.length}; rejected candidate attempts ${group.rejectedAttempts}/${group.candidateAttempts}; aria-tree gaming rejections ${group.gamingAttempts}; p50/p95 run ms ${group.p50RunMs ?? "n/a"}/${group.p95RunMs ?? "n/a"}.`), "",
    "## Incomplete operations", "",
    ...summary.cells.filter(cell => cell.status !== "completed").map(cell => `- ${cell.repository}@${cell.sha}, ${cell.system}, seed ${cell.seed}, batch ${cell.batch}: ${cell.status}; ${cell.reason ?? "no reason recorded"}.`), "",
    "Not measured by this report: calibrated-judge correctness, manual/screen-reader audit, cross-benchmark head-to-head results, and provider invoice/cache-hit attribution. Source-line localization and accepted/final regression counts should be interpreted together with the retained patch evidence.", "",
  ].join("\n");
}
