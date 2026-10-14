import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaults, loadConfig } from "../config.js";
import { SourceBaseline } from "../sandbox/apply-verified.js";
import { DockerRepairSession } from "../runner/repair-session.js";
import type { RepairSessionOptions } from "../runner/repair-session.js";
import { makeRunReport } from "../reporter/report.js";
import { summarizeScans } from "../reporter/scan-summary.js";
import { renderEvidenceReport } from "../reporter/evidence-report.js";
import type { RunReport } from "../reporter/report.js";
import type { PublishInput } from "../reporter/github-publisher.js";
import { appendRunRecord } from "../tracer/run-record.js";
import { BudgetLedger } from "../llm/budget.js";
import { LlmClient } from "../llm/client.js";
import { AiSdkLlmProvider } from "../llm/ai-sdk-provider.js";
import { DurableBudgetProvider } from "../llm/durable-provider.js";
import type { DurableProviderOptions } from "../llm/durable-provider.js";
import type { ModelPricing } from "../llm/ai-sdk-provider.js";
import type { LlmProvider } from "../llm/types.js";
import { resolveExecutionModel } from "../llm/execution-policy.js";
import { createSemanticRepair } from "../llm/semantic-runner.js";
import { runRepair } from "./repair.js";
import type { SemanticRepair } from "./repair.js";
import { isSourcePath } from "../types/schemas.js";
import type { LlmModelConfig } from "../types/schemas.js";

export interface RepositoryRepairOptions {
  repoPath: string;
  tempRoot: string;
  runtimeRoot: string;
  noLlm?: boolean;
  offline?: boolean;
  dryRun?: boolean;
  retainEvidence?: boolean;
  /** Explicit local diagnostics for owned fixtures; never enabled by target config or Action inputs. */
  privateDiagnostics?: boolean;
  maxTasks?: number;
  /** Trusted PR-mode scope. Unknown/shared files conservatively map to all routes. */
  changedPaths?: readonly string[];
  /** Operator authorization, never inherited upward from a target repository. Defaults to zero. */
  maxCostUsd?: number;
  pricing?: ModelPricing;
  trustProviderConfig?: boolean;
  /** Trusted coordinator-only cumulative allowance; never read from target configuration. */
  durableBudget?: Pick<DurableProviderOptions, "ledger" | "maxInputTokens" | "expiresAt">;
  /** Explicit injection is labeled fake-provider; normal product code constructs the real transport. */
  provider?: LlmProvider;
  /** Progress callback for every recorded run step. */
  onStep?: RepairSessionOptions["onStep"];
  /** Explicit model choice; overrides `.accesswright.yml` and automatic detection. */
  model?: LlmModelConfig;
  /** Where target code runs. "auto" picks Docker when available, otherwise the host. Default "docker". */
  sandbox?: SandboxChoice;
  /** Extra non-secret target variables, merged over `.accesswright.yml` `env`. */
  env?: Readonly<Record<string, string>>;
}
export type SandboxChoice = "auto" | "docker" | "host";
/** Why model-assisted repair is on or off for a run, for user-facing output. */
export type LlmSetup =
  | { status: "enabled"; provider: string; id: string; maxCostUsd: number; source: "option" | "config" | "auto" }
  | { status: "disabled"; reason: string };
export interface RepositoryRepairOutput {
  report: RunReport;
  evidenceDir: string;
  groups: PublishInput["groups"];
  llm: LlmSetup;
  sandbox: "docker" | "host";
}

/** Single entrypoint shared by CLI, Action and MCP. Target code runs only in the isolated Docker runner. */
export async function repairRepository(options: RepositoryRepairOptions): Promise<RepositoryRepairOutput> {
  const startedAt = new Date().toISOString();
  const config = await loadConfig(options.repoPath, options.offline === undefined ? {} : { offline: options.offline });
  const authorizedCost = z.number().finite().nonnegative().parse(options.maxCostUsd ?? defaults.maxRunCostUsd);
  const limit = Math.min(authorizedCost, config.maxCostUsd ?? authorizedCost);
  const budget = new BudgetLedger({ maxRunCostUsd: limit, maxTaskTokens: defaults.maxTaskTokens });
  const session = await DockerRepairSession.prepare({ repoPath: options.repoPath, tempRoot: options.tempRoot, runtimeRoot: options.runtimeRoot, config,
    ...(options.privateDiagnostics === undefined ? {} : { privateDiagnostics: options.privateDiagnostics }),
    ...(options.retainEvidence === undefined ? {} : { retainEvidence: options.retainEvidence }),
    ...(options.onStep === undefined ? {} : { onStep: options.onStep }) });
  try {
    const baseline = await SourceBaseline.fromSnapshot(options.repoPath, session.sourceRoot, options.tempRoot);
    let semanticRepair: SemanticRepair | undefined;
    let llm: LlmSetup = { status: "disabled", reason: options.noLlm ? "disabled by --no-llm" : config.model === undefined ? "no model configured" : limit <= 0 ? "cost cap is 0" : "no model pricing" };
    let providerCalls = 0;
    const changedPaths = options.changedPaths === undefined ? undefined : z.array(z.string().min(1).refine(isSourcePath)).max(300).refine(paths => new Set(paths).size === paths.length, "Duplicate changed path").parse(options.changedPaths);
    const changedRoutes = changedPaths === undefined ? undefined : new Set(session.affectedRoutes(changedPaths));
    if (!options.noLlm && config.model !== undefined && limit > 0 && options.pricing !== undefined) {
      const pricing = z.object({ inputUsdPerMillion: z.number().finite().nonnegative(), outputUsdPerMillion: z.number().finite().nonnegative() }).strict().parse(options.pricing);
      const model = resolveExecutionModel(config.model, options.trustProviderConfig === true);
      const provider = options.provider ?? new AiSdkLlmProvider({ pricing: requested => requested.provider === model.provider && requested.id === model.id ? pricing : null });
      const metered = options.durableBudget === undefined ? provider : new DurableBudgetProvider(provider, { ...options.durableBudget, model, pricing });
      const client = new LlmClient(metered, async event => {
        providerCalls += 1;
        await appendRunRecord(join(session.evidenceDir, "run.jsonl"), {
          timestamp: new Date().toISOString(),
          step: "llm",
          status: event.status,
          model: event.model,
          ...(event.usage === undefined ? {} : { usage: event.usage }),
          metadata: { taskType: event.taskType, promptHash: event.promptHash },
        });
      });
      semanticRepair = createSemanticRepair({ session, client, budget, model, pricing });
      llm = { status: "enabled", provider: model.provider, id: model.id, maxCostUsd: limit, source: "config" };
    }
    const result = await runRepair(session, { noLlm: options.noLlm === true,
      ...(options.maxTasks === undefined ? {} : { maxTasks: options.maxTasks }),
      ...(semanticRepair === undefined ? {} : { semanticRepair }),
      ...(changedRoutes === undefined ? {} : { includeTask: (task) => task.routes.some(route => changedRoutes.has(route)) }),
    });
    const patches = result.status === "verified" ? await session.journal.exportPatches(result.final.acceptedFixIds) : [];
    const groups: PublishInput["groups"] = patches.map(patch => {
      const task = session.tasks.get(patch.taskId);
      if (!task) throw new Error("Final patch lost its verified task provenance");
      return { id: task.id, ruleId: task.ruleId, criterion: task.criterion, perPatchAccepted: true, changes: patch.changes };
    });
    let applied = false;
    if (result.status === "verified" && result.patch !== null && options.dryRun !== true) {
      await baseline.apply(result.patch);
      applied = true;
    }
    const report = makeRunReport({ result, startedAt, finishedAt: new Date().toISOString(), applied, checks: session.finalChecks,
      usage: budget.snapshot(), unknownUsage: budget.hasUnknownUsage(),
      scanSummary: summarizeScans(session.productionBaseline, session.finalObservations, session.baselineObservations),
      providerVerification: providerCalls === 0 ? "not-run" : options.provider ? "fake-provider" : "provider-api" });
    await writeFile(join(session.evidenceDir, "report.json"), JSON.stringify(report, null, 2));
    const evidenceCommits = session.journal.fixes
      .filter(fix => report.final.acceptedFixIds.includes(fix.id))
      .map(fix => ({ id: fix.id, commit: fix.commit }));
    await writeFile(
      join(session.evidenceDir, "accesswright-report.md"),
      renderEvidenceReport(report, { commits: evidenceCommits }),
      { flag: "wx", mode: 0o600 },
    );
    return { report, evidenceDir: session.evidenceDir, groups, llm, sandbox: "docker" };
  } finally { await session.close(); }
}
