import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { defaults } from "../config.js";
import { appendRunRecord } from "../tracer/run-record.js";
import { HostedCandidateSchema, hostedCandidateDigest } from "./agent-protocol.js";
import type { HostedCandidate } from "./agent-protocol.js";
import type { HostedPatchAgent } from "./agent-api.js";
import type { GcsHostedCandidateStore } from "./gcs-candidate-store.js";
import { clearHostedCandidate } from "./candidate-cleanup.js";
import type { FirestoreCandidateCleanupStore } from "./candidate-cleanup.js";
import { eligibleForTrustedVerification, hostedReportDigest } from "./run-workflow.js";
import { verifyHostedCandidate } from "./trusted-verifier.js";
import type { HostedVerificationCheckout, HostedVerifiedCandidate } from "./trusted-verifier.js";
import { hostedVerifiedArtifactDigest } from "./verified-publication.js";
import type { HostedVerifiedCandidateConsumer } from "./verified-publication.js";

/** Mount behind HostedRunWorkflow's durable staging/verification claims; workers never call the verifier directly. */
export function createHostedCandidateCoordinator(options: {
  agent: Pick<HostedPatchAgent, "sealForVerification">;
  store: Pick<GcsHostedCandidateStore, "put" | "get" | "remove">;
  cleanup: Pick<FirestoreCandidateCleanupStore, "claim" | "confirm" | "get">;
  evidenceRoot: string;
  resolveCheckout: (runId: string) => Promise<HostedVerificationCheckout>;
  /** Durably enqueue only the run/report identity before any private upload. */
  scheduleVerification: (runId: string, reportDigest: string) => Promise<void>;
  onVerifiedCandidate?: HostedVerifiedCandidateConsumer;
  ttlSeconds?: number;
}) {
  const runSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
  const ttl = z.number().int().min(defaults.hostedMinTtlSeconds).max(defaults.hostedMaxTtlSeconds).parse(options.ttlSeconds ?? defaults.hostedDefaultTtlSeconds);
  const record = async (runId: string, step: string, status: "ok" | "rejected" | "error", digest: string) => {
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
      try {
        await options.cleanup.claim(runId, reference);
        await record(runId, "hosted-candidate-staged", "ok", digest);
      }
      catch {
        await clearHostedCandidate(options, runId, reference);
        throw new Error("Private candidate staging evidence failed");
      }
    },
    verifyTrustedResult: async (rawRunId: string, rawDigest: string) => {
      const runId = runSchema.parse(rawRunId), digest = z.string().regex(/^[a-f0-9]{64}$/).parse(rawDigest);
      const staged = await options.store.get(runId);
      if (!staged) {
        const previous = await options.cleanup.get(runId);
        if (previous?.status === "pending") {
          await clearHostedCandidate(options, runId, { generation: previous.generation, expiresAt: previous.expiresAt, candidateDigest: previous.candidateDigest });
          await record(runId, "hosted-candidate-cleared", "ok", previous.candidateDigest);
        }
        return null;
      }
      const { candidate, ...reference } = staged;
      let verified: HostedVerifiedCandidate | null;
      try {
        if (hostedReportDigest(candidate.report) !== digest) return null;
        const reconciled = await options.agent.sealForVerification(runId);
        const checkout = await options.resolveCheckout(runId);
        try {
          verified = await verifyHostedCandidate({ ...checkout, reconciled }, candidate);
          if (verified && (verified.receipt.reportDigest !== digest || verified.receipt.verifiedBaseSha !== checkout.verifiedBaseSha ||
            verified.artifact.candidateDigest !== staged.candidateDigest || verified.artifact.workerReportDigest !== digest ||
            verified.artifact.verifiedBaseSha !== checkout.verifiedBaseSha)) throw new Error("Trusted artifact and staged candidate identity mismatch");
        }
        finally {
          await checkout.release().catch(async (error: unknown) => {
            await record(runId, "hosted-checkout-cleanup-unconfirmed", "rejected", staged.candidateDigest); throw error;
          });
          await record(runId, "hosted-checkout-cleared", "ok", staged.candidateDigest);
        }
      } finally {
        // A replay success is withheld if private-source deletion cannot be confirmed.
        await clearHostedCandidate(options, runId, reference);
        await record(runId, "hosted-candidate-cleared", "ok", staged.candidateDigest);
      }
      if (verified && options.onVerifiedCandidate) {
        try {
          await options.onVerifiedCandidate(runId, verified.artifact, hostedVerifiedArtifactDigest(verified.artifact));
          await record(runId, "hosted-verified-artifact-delivered", "ok", staged.candidateDigest);
        } catch (error) {
          await record(runId, "hosted-verified-artifact-delivery-unconfirmed", "error", staged.candidateDigest);
          throw error;
        }
      }
      return verified?.receipt ?? null;
    },
  };
}
