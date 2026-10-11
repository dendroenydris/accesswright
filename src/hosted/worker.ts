import { join } from "node:path";
import { z } from "zod";
import { defaults } from "../config.js";
import { runRepair } from "../core/repair.js";
import type { SemanticRepair } from "../core/repair.js";
import { gatherRepairContext } from "../llm/gather-context.js";
import { makeRunReport } from "../reporter/report.js";
import type { RunReport } from "../reporter/report.js";
import { summarizeScans } from "../reporter/scan-summary.js";
import { EphemeralRepairSession } from "../runner/ephemeral-repair-session.js";
import { workerLayout } from "../runner/worker-boundary.js";
import { appendRunRecord } from "../tracer/run-record.js";
import type { AccesswrightConfigSchema } from "../types/schemas.js";
import type { HostedAgentClient } from "./agent-client.js";
import type { HostedPatchResponse } from "./agent-api.js";
import { HostedCandidateSchema } from "./agent-protocol.js";
import type { HostedCandidate } from "./agent-protocol.js";

/** Service-side caps authorize calls; the candidate worker records responses and blocks unknown retries. */
export function createHostedSemanticRepair(options: {
  session: Pick<EphemeralRepairSession, "sourceRoot" | "evidenceDir" | "observations">;
  client: Pick<HostedAgentClient, "patch">;
  providerVerification: Exclude<RunReport["providerVerification"], "not-run">;
}) {
  const providerVerification = z.enum(["fake-provider", "provider-api"]).parse(options.providerVerification);
  let inputTokens = 0, outputTokens = 0, spentUsd = 0, settledRequests = 0, unknownUsage = false;
  const repair: SemanticRepair = async (task, verify) => {
    if (unknownUsage) return { status: "needs-human", reason: "Agent usage is unreconciled; further calls are blocked" };
    let gathered: Awaited<ReturnType<typeof gatherRepairContext>>;
    try { gathered = await gatherRepairContext({ root: options.session.sourceRoot, evidenceDir: options.session.evidenceDir, task, observations: options.session.observations }); }
    catch {
      await appendRunRecord(join(options.session.evidenceDir, "run.jsonl"), { timestamp: new Date().toISOString(), step: "hosted-context", status: "skipped", metadata: { ruleId: task.ruleId } });
      return { status: "needs-human", reason: "Bounded rendered context is unavailable" };
    }
    let feedback: string | null = null;
    for (let attempt = 1; attempt <= defaults.maxAttempts; attempt++) {
      const started = Date.now();
      let response: HostedPatchResponse;
      try { response = await options.client.patch(task, gathered.context, gathered.images, feedback); }
      catch {
        // The client validates input before transport and converts lost responses to unknown usage.
        await appendRunRecord(join(options.session.evidenceDir, "run.jsonl"), { timestamp: new Date().toISOString(), step: "hosted-request", status: "rejected",
          durationMs: Date.now() - started, metadata: { ruleId: task.ruleId, attempt } });
        return { status: "needs-human", reason: "Bounded agent request is unavailable" };
      }
      if (response.usage) {
        inputTokens += response.usage.inputTokens; outputTokens += response.usage.outputTokens; spentUsd += response.usage.costUsd; settledRequests++;
      } else unknownUsage = true;
      await appendRunRecord(join(options.session.evidenceDir, "run.jsonl"), { timestamp: new Date().toISOString(), step: "hosted-model", status: response.status === "accepted" ? "ok" : "rejected",
        durationMs: Date.now() - started, ...(response.usage ? { usage: response.usage } : {}), metadata: { ruleId: task.ruleId, attempt, unknownUsage } });
      if (unknownUsage) return { status: "needs-human", reason: "Agent usage is unreconciled; further calls are blocked" };
      if (response.status === "rejected") feedback = response.reason;
      else {
        const verdict = await verify(response.patch);
        if (verdict.accepted) return { status: "accepted" };
        feedback = "rule=" + task.ruleId + "; check=" + verdict.check + "; reason=" + (verdict.reason ?? "Verification failed");
      }
      feedback = feedback.slice(0, defaults.hostedMaxFeedbackChars);
    }
    return { status: "needs-human", reason: "Bounded agent attempts exhausted" };
  };
  return { repair, accounting: (): Pick<RunReport, "usage" | "unknownUsage" | "providerVerification"> => ({
    usage: { inputTokens, outputTokens, spentUsd }, unknownUsage, providerVerification: settledRequests ? providerVerification : "not-run",
  }) };
}

/** No provider/GitHub credentials or publishing authority. Candidate transfer occurs only after cleanup. */
export async function runHostedWorker(options: {
  client?: Pick<HostedAgentClient, "patch">;
  providerVerification: Exclude<RunReport["providerVerification"], "not-run">;
  config?: z.input<typeof AccesswrightConfigSchema>;
  submitCandidate: (candidate: HostedCandidate) => Promise<void>;
}): Promise<RunReport> {
  z.enum(["fake-provider", "provider-api"]).parse(options.providerVerification);
  const startedAt = new Date().toISOString();
  const session = await EphemeralRepairSession.prepare({ repoPath: workerLayout.input, ...(options.config === undefined ? {} : { config: options.config }) });
  let candidate: HostedCandidate;
  try {
    const remote = options.client ? createHostedSemanticRepair({ session, client: options.client, providerVerification: options.providerVerification }) : undefined;
    const result = await runRepair(session, { noLlm: !remote, ...(remote ? { semanticRepair: remote.repair } : {}) });
    const patches = result.status === "verified" ? await session.journal.exportPatches(result.final.acceptedFixIds) : [];
    const accounting = remote?.accounting() ?? { usage: { inputTokens: 0, outputTokens: 0, spentUsd: 0 }, unknownUsage: false, providerVerification: "not-run" as const };
    const report = makeRunReport({ result, startedAt, finishedAt: new Date().toISOString(), applied: false, checks: session.finalChecks, ...accounting,
      scanSummary: summarizeScans(session.productionBaseline, session.finalObservations, session.baselineObservations) });
    candidate = HostedCandidateSchema.parse({ report, patches });
    await appendRunRecord(join(session.evidenceDir, "run.jsonl"), { timestamp: new Date().toISOString(), step: "hosted-worker", status: result.status === "verified" ? "ok" : "rejected",
      durationMs: Date.now() - Date.parse(startedAt), metadata: { acceptedFixes: patches.length, unknownUsage: report.unknownUsage } });
  } finally { await session.close(); }
  const transferStarted = Date.now();
  try {
    await options.submitCandidate(candidate);
    await appendRunRecord(join(session.evidenceDir, "run.jsonl"), { timestamp: new Date().toISOString(), step: "hosted-candidate-transfer", status: "ok", durationMs: Date.now() - transferStarted });
  } catch (error) {
    await appendRunRecord(join(session.evidenceDir, "run.jsonl"), { timestamp: new Date().toISOString(), step: "hosted-candidate-transfer", status: "error",
      durationMs: Date.now() - transferStarted, metadata: { errorClass: error instanceof Error ? error.name : "unknown" } });
    throw error;
  }
  return candidate.report;
}
