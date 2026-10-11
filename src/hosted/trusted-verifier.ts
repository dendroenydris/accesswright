import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { runRepair } from "../core/repair.js";
import type { RepairRuntime } from "../core/repair.js";
import { compareSourceSnapshots } from "../mcp/source-diff.js";
import { DockerRepairSession } from "../runner/repair-session.js";
import { verifyCheckoutProvenance } from "../runner/checkout-provenance.js";
import type { RepairSessionOptions } from "../runner/repair-session.js";
import type { ProductionCheckResult } from "../runner/production-checks.js";
import { RunReportSchema } from "../reporter/report.js";
import type { RunReport } from "../reporter/report.js";
import { copyTargetSnapshot } from "../sandbox/source-boundary.js";
import { appendRunRecord } from "../tracer/run-record.js";
import { HostedCandidateSchema } from "./agent-protocol.js";
import { eligibleForTrustedVerification, hostedReportDigest } from "./run-workflow.js";
import type { TrustedRunReceipt } from "./run-workflow.js";

interface VerificationRuntime extends RepairRuntime {
  evidenceDir: string;
  finalChecks: ProductionCheckResult[];
  close(): Promise<void>;
}

export interface HostedVerificationOptions {
  /** Fresh coordinator-owned checkout; never a worker-provided path or SHA. */
  repoPath: string;
  verifiedBaseSha: string;
  tempRoot: string;
  runtimeRoot: string;
  /** Independently reconciled service usage, never copied from the job report. */
  reconciled: Pick<RunReport, "usage" | "unknownUsage" | "providerVerification">;
}

/** Replays only claimed patches in a fresh Docker verifier; never calls a provider or publishes. */
export async function verifyHostedCandidate(
  options: HostedVerificationOptions,
  input: unknown,
  dependencies: { prepare?: (options: RepairSessionOptions) => Promise<VerificationRuntime> } = {},
): Promise<TrustedRunReceipt | null> {
  const parsed = HostedCandidateSchema.safeParse(input);
  const reconciled = RunReportSchema.pick({ usage: true, unknownUsage: true, providerVerification: true }).parse(options.reconciled);
  if (!parsed.success) return null;
  const { report, patches } = parsed.data;
  const ids = report.final.acceptedFixIds;
  if (!eligibleForTrustedVerification(report) || reconciled.unknownUsage ||
    JSON.stringify(report.usage) !== JSON.stringify(reconciled.usage) || report.providerVerification !== reconciled.providerVerification ||
    !patches.length || patches.length !== ids.length || new Set(patches.map(patch => patch.taskId)).size !== ids.length ||
    patches.some(patch => !ids.includes(patch.taskId))) return null;
  const sha = z.string().regex(/^[a-f0-9]{40}$/).parse(options.verifiedBaseSha);
  await verifyCheckoutProvenance(options.repoPath, sha);
  await mkdir(options.tempRoot, { recursive: true });
  const scratch = await mkdtemp(join(options.tempRoot, "hosted-verification-"));
  let session: VerificationRuntime | undefined;
  const started = Date.now();
  try {
    const base = join(scratch, "base");
    await copyTargetSnapshot(options.repoPath, base);
    await verifyCheckoutProvenance(options.repoPath, sha);
    session = await (dependencies.prepare ?? DockerRepairSession.prepare)({
      repoPath: base, tempRoot: options.tempRoot, runtimeRoot: options.runtimeRoot,
      retainEvidence: false, privateDiagnostics: false,
    });
    const proposals = new Map(patches.map(patch => [patch.taskId, patch]));
    const result = await runRepair(session, {
      includeTask: task => proposals.has(task.id),
      proposalRepair: async (task, verify) => {
        const patch = proposals.get(task.id);
        const outcome = report.outcomes.find(item => item.id === task.id && item.status === "verified");
        if (!patch || outcome?.ruleId !== task.ruleId || outcome.criterion !== task.criterion || outcome.route !== task.route) {
          return { status: "needs-human", reason: "Claimed task provenance did not reproduce" };
        }
        const verdict = await verify(patch);
        return { status: verdict.accepted ? "accepted" : "needs-human" };
      },
    });
    const after = join(scratch, "source-after");
    await copyTargetSnapshot(options.repoPath, after);
    await verifyCheckoutProvenance(options.repoPath, sha);
    const accepted = result.status === "verified" && result.final.acceptedFixIds.length === ids.length &&
      ids.every(id => result.final.acceptedFixIds.includes(id)) &&
      session.finalChecks.length === report.checks.length && report.checks.every(claim => {
        const matching = session?.finalChecks.filter(check => check.check === claim.check) ?? [];
        return matching.length === 1 && matching[0]?.available === true && matching[0].status === "passed" &&
          matching[0].exitCode === 0 && matching[0].failureIds.length === 0;
      }) &&
      (await compareSourceSnapshots(base, after)).length === 0;
    await appendRunRecord(join(session.evidenceDir, "run.jsonl"), {
      timestamp: new Date().toISOString(), step: "trusted-verification", status: accepted ? "ok" : "rejected",
      durationMs: Date.now() - started, metadata: { reportDigest: hostedReportDigest(report), baseSha: sha, patchCount: patches.length },
    });
    return accepted ? { reportDigest: hostedReportDigest(report), verifiedBaseSha: sha } : null;
  } catch (error) {
    if (session) await appendRunRecord(join(session.evidenceDir, "run.jsonl"), {
      timestamp: new Date().toISOString(), step: "trusted-verification", status: "error", durationMs: Date.now() - started,
      metadata: { errorClass: error instanceof Error ? error.name : "unknown", baseSha: sha, patchCount: patches.length },
    });
    throw error;
  } finally {
    try { await session?.close(); }
    finally { await rm(scratch, { recursive: true, force: true }); }
  }
}
