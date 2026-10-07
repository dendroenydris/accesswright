import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaults, loadConfig } from "../config.js";
import { SourceBaseline } from "../sandbox/apply-verified.js";
import { DockerRepairSession } from "../runner/repair-session.js";
import { makeRunReport } from "../reporter/report.js";
import type { RunReport } from "../reporter/report.js";
import type { PublishInput } from "../reporter/github-publisher.js";
import { appendRunRecord } from "../tracer/run-record.js";
import { BudgetLedger } from "../llm/budget.js";
import { LlmClient } from "../llm/client.js";
import { AiSdkLlmProvider } from "../llm/ai-sdk-provider.js";
import type { ModelPricing } from "../llm/ai-sdk-provider.js";
import type { LlmProvider } from "../llm/types.js";
import { resolveExecutionModel } from "../llm/execution-policy.js";
import { createSemanticRepair } from "../llm/semantic-runner.js";
import { runRepair } from "./repair.js";
import type { SemanticRepair } from "./repair.js";

export interface RepositoryRepairOptions {
  repoPath: string;
  tempRoot: string;
  runtimeRoot: string;
  noLlm?: boolean;
  offline?: boolean;
  dryRun?: boolean;
  retainEvidence?: boolean;
  maxTasks?: number;
  /** Operator authorization, never inherited upward from a target repository. Defaults to zero. */
  maxCostUsd?: number;
  pricing?: ModelPricing;
  trustProviderConfig?: boolean;
  /** Explicit injection is labeled fake-provider; normal product code constructs the real transport. */
  provider?: LlmProvider;
}
export interface RepositoryRepairOutput {
  report: RunReport;
  evidenceDir: string;
  groups: PublishInput["groups"];
}

/** Single entrypoint shared by CLI, Action and MCP. Target code runs only in the isolated Docker runner. */
export async function repairRepository(options: RepositoryRepairOptions): Promise<RepositoryRepairOutput> {
  const startedAt = new Date().toISOString();
  const config = await loadConfig(options.repoPath, options.offline === undefined ? {} : { offline: options.offline });
  const authorizedCost = z.number().finite().nonnegative().parse(options.maxCostUsd ?? defaults.maxRunCostUsd);
  const limit = Math.min(authorizedCost, config.maxCostUsd ?? authorizedCost);
  const budget = new BudgetLedger({ maxRunCostUsd: limit, maxTaskTokens: defaults.maxTaskTokens });
  const session = await DockerRepairSession.prepare({ repoPath: options.repoPath, tempRoot: options.tempRoot, runtimeRoot: options.runtimeRoot, config,
    ...(options.retainEvidence === undefined ? {} : { retainEvidence: options.retainEvidence }) });
  try {
    const baseline = await SourceBaseline.fromSnapshot(options.repoPath, session.sourceRoot, options.tempRoot);
    let semanticRepair: SemanticRepair | undefined;
    let providerCalls = 0;
    if (!options.noLlm && config.model !== undefined && limit > 0 && options.pricing !== undefined) {
      const pricing = z.object({ inputUsdPerMillion: z.number().finite().nonnegative(), outputUsdPerMillion: z.number().finite().nonnegative() }).strict().parse(options.pricing);
      const model = resolveExecutionModel(config.model, options.trustProviderConfig === true);
      const client = new LlmClient(options.provider ?? new AiSdkLlmProvider({ pricing: requested => requested.provider === model.provider && requested.id === model.id ? pricing : null }), async event => {
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
    }
    const result = await runRepair(session, { noLlm: options.noLlm === true,
      ...(options.maxTasks === undefined ? {} : { maxTasks: options.maxTasks }), ...(semanticRepair === undefined ? {} : { semanticRepair }) });
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
      providerVerification: providerCalls === 0 ? "not-run" : options.provider ? "fake-provider" : "provider-api" });
    await writeFile(join(session.evidenceDir, "report.json"), JSON.stringify(report, null, 2));
    return { report, evidenceDir: session.evidenceDir, groups };
  } finally { await session.close(); }
}
