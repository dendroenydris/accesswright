import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { defaults } from "../config.js";
import { appendRunRecord } from "../tracer/run-record.js";
import { HostedCandidateSchema, hostedCandidateDigest } from "./agent-protocol.js";
import type { HostedCandidate } from "./agent-protocol.js";
import type { HostedPatchAgent } from "./agent-api.js";
import type { GcsHostedCandidateStore } from "./gcs-candidate-store.js";
import { eligibleForTrustedVerification, hostedReportDigest } from "./run-workflow.js";
import { verifyHostedCandidate } from "./trusted-verifier.js";
import type { HostedVerificationOptions } from "./trusted-verifier.js";

/** Mount behind HostedRunWorkflow's durable staging/verification claims; workers never call the verifier directly. */
export function createHostedCandidateCoordinator(options: {
  agent: Pick<HostedPatchAgent, "sealForVerification">;
  store: Pick<GcsHostedCandidateStore, "put" | "get" | "remove">;
  evidenceRoot: string;
  resolveCheckout: (runId: string) => Promise<Omit<HostedVerificationOptions, "reconciled">>;
  /** Durably enqueue only the run/report identity before any private upload. */
  scheduleVerification: (runId: string, reportDigest: string) => Promise<void>;
  ttlSeconds?: number;
}) {
  const runSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
  const ttl = z.number().int().min(defaults.hostedMinTtlSeconds).max(defaults.hostedMaxTtlSeconds).parse(options.ttlSeconds ?? defaults.hostedDefaultTtlSeconds);
  const record = async (runId: string, step: string, status: "ok" | "rejected", digest: string) => {
    const directory = join(options.evidenceRoot, runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendRunRecord(join(directory, "run.jsonl"), { timestamp: new Date().toISOString(), step, status, metadata: { candidateDigest: digest } });
  };
  return {
    receiveCandidate: async (rawRunId: string, input: HostedCandidate): Promise<void> => {
      const runId = runSchema.parse(rawRunId), candidate = HostedCandidateSchema.parse(input);
      if (Buffer.byteLength(JSON.stringify(candidate)) > defaults.hostedMaxCandidateBodyBytes) throw new Error("Candidate exceeds its byte limit");
      const digest = hostedCandidateDigest(candidate);
      const reconciled = await options.agent.sealForVerification(runId);
      if (JSON.stringify(reconciled.usage) !== JSON.stringify(candidate.report.usage) || reconciled.unknownUsage !== candidate.report.unknownUsage ||
        reconciled.providerVerification !== candidate.report.providerVerification) throw new Error("Candidate usage does not match trusted service settlements");
      await options.scheduleVerification(runId, hostedReportDigest(candidate.report));
      if (!eligibleForTrustedVerification(candidate.report) || !candidate.patches.length) {
        await record(runId, "hosted-candidate-discarded", "rejected", digest);
        return;
      }
      const reference = await options.store.put(runId, candidate, ttl);
      try { await record(runId, "hosted-candidate-staged", "ok", digest); }
      catch {
        await options.store.remove(runId, reference.generation);
        throw new Error("Private candidate staging evidence failed");
      }
    },
    verifyTrustedResult: async (rawRunId: string, rawDigest: string) => {
      const runId = runSchema.parse(rawRunId), digest = z.string().regex(/^[a-f0-9]{64}$/).parse(rawDigest);
      const staged = await options.store.get(runId);
      if (!staged) return null;
      try {
        if (hostedReportDigest(staged.candidate.report) !== digest) return null;
        const reconciled = await options.agent.sealForVerification(runId);
        const checkout = await options.resolveCheckout(runId);
        return await verifyHostedCandidate({ ...checkout, reconciled }, staged.candidate);
      } finally {
        // A replay success is withheld if private-source deletion cannot be confirmed.
        await options.store.remove(runId, staged.generation);
        await record(runId, "hosted-candidate-cleared", "ok", staged.candidateDigest);
      }
    },
  };
}
