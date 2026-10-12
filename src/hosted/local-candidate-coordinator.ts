import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaults } from "../config.js";
import { appendRunRecord } from "../tracer/run-record.js";
import { HostedCandidateSchema, hostedCandidateDigest } from "./agent-protocol.js";
import type { HostedCandidate } from "./agent-protocol.js";
import type { HostedPatchAgent } from "./agent-api.js";
import { eligibleForTrustedVerification, hostedReportDigest } from "./run-workflow.js";
import { verifyHostedCandidate } from "./trusted-verifier.js";
import type { HostedVerificationCheckout, HostedVerifiedCandidate } from "./trusted-verifier.js";
import { hostedVerifiedArtifactDigest } from "./verified-publication.js";
import type { HostedVerifiedCandidateConsumer } from "./verified-publication.js";

/** Local trusted coordinator only. Pending private payloads are lost on restart; cloud needs durable private staging. */
export function createLocalHostedCandidateCoordinator(options: {
  agent: Pick<HostedPatchAgent, "sealForVerification">;
  evidenceRoot: string;
  resolveCheckout: (runId: string) => Promise<HostedVerificationCheckout>;
  onVerifiedCandidate?: HostedVerifiedCandidateConsumer;
  ttlSeconds?: number;
}) {
  const ttl = z.number().int().min(defaults.hostedMinTtlSeconds).max(defaults.hostedMaxTtlSeconds).parse(options.ttlSeconds ?? defaults.hostedDefaultTtlSeconds);
  const pending = new Map<string, { candidate: HostedCandidate; digest: string; timer: ReturnType<typeof setTimeout>; ready: Promise<void> }>();
  const record = async (runId: string, step: string, status: "ok" | "rejected" | "error", digest: string) => {
    const directory = join(options.evidenceRoot, runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendRunRecord(join(directory, "run.jsonl"), { timestamp: new Date().toISOString(), step, status, metadata: { candidateDigest: digest } });
  };
  return {
    receiveCandidate: async (rawRunId: string, input: HostedCandidate): Promise<void> => {
      const runId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).parse(rawRunId);
      const candidate = HostedCandidateSchema.parse(input);
      if (Buffer.byteLength(JSON.stringify(candidate)) > defaults.hostedMaxCandidateBodyBytes) throw new Error("Candidate exceeds its byte limit");
      const digest = hostedCandidateDigest(candidate);
      const existing = pending.get(runId);
      if (existing) {
        if (existing.digest !== digest) throw new Error("Conflicting candidate changed after submission");
        await existing.ready;
        return;
      }
      const reconciled = await options.agent.sealForVerification(runId);
      if (JSON.stringify(reconciled.usage) !== JSON.stringify(candidate.report.usage) || reconciled.unknownUsage !== candidate.report.unknownUsage ||
        reconciled.providerVerification !== candidate.report.providerVerification) throw new Error("Candidate usage does not match trusted service settlements");
      if (!eligibleForTrustedVerification(candidate.report) || !candidate.patches.length) {
        await record(runId, "hosted-candidate-discarded", "rejected", digest);
        return;
      }
      // Recheck after sealing: concurrent receivers can both await the same service transaction.
      const concurrent = pending.get(runId);
      if (concurrent) {
        if (concurrent.digest !== digest) throw new Error("Conflicting candidate changed after submission");
        await concurrent.ready;
        return;
      }
      if (pending.size >= defaults.hostedMaxStagedCandidates) throw new Error("Private candidate staging limit exceeded");
      const timer = setTimeout(() => {
        pending.delete(runId);
        void record(runId, "hosted-candidate-expired", "rejected", digest).catch(() => { /* Payload deletion precedes diagnostic I/O. */ });
      }, ttl * 1000);
      timer.unref();
      const staged = { candidate, digest, timer, ready: Promise.resolve() };
      pending.set(runId, staged);
      staged.ready = record(runId, "hosted-candidate-staged", "ok", digest);
      try {
        await staged.ready;
        if (pending.get(runId) !== staged) throw new Error("Candidate staging expired before acknowledgment");
      }
      catch (error) { clearTimeout(timer); pending.delete(runId); throw error; }
    },
    verifyTrustedResult: async (rawRunId: string, reportDigest: string) => {
      const runId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).parse(rawRunId);
      const staged = pending.get(runId);
      if (!staged) return null;
      await staged.ready;
      if (pending.get(runId) !== staged) return null;
      clearTimeout(staged.timer);
      pending.delete(runId);
      let verified: HostedVerifiedCandidate | null;
      try {
        if (hostedReportDigest(staged.candidate.report) !== reportDigest) return null;
        const reconciled = await options.agent.sealForVerification(runId);
        const checkout = await options.resolveCheckout(runId);
        try {
          verified = await verifyHostedCandidate({ ...checkout, reconciled }, staged.candidate);
          if (verified && (verified.receipt.reportDigest !== reportDigest || verified.receipt.verifiedBaseSha !== checkout.verifiedBaseSha ||
            verified.artifact.candidateDigest !== staged.digest || verified.artifact.workerReportDigest !== reportDigest ||
            verified.artifact.verifiedBaseSha !== checkout.verifiedBaseSha)) throw new Error("Trusted artifact and staged candidate identity mismatch");
        }
        finally {
          await checkout.release().catch(async (error: unknown) => {
            await record(runId, "hosted-checkout-cleanup-unconfirmed", "rejected", staged.digest); throw error;
          });
          await record(runId, "hosted-checkout-cleared", "ok", staged.digest);
        }
      } finally { await record(runId, "hosted-candidate-cleared", "ok", staged.digest); }
      if (verified && options.onVerifiedCandidate) {
        try {
          await options.onVerifiedCandidate(runId, verified.artifact, hostedVerifiedArtifactDigest(verified.artifact));
          await record(runId, "hosted-verified-artifact-delivered", "ok", staged.digest);
        } catch (error) {
          await record(runId, "hosted-verified-artifact-delivery-unconfirmed", "error", staged.digest);
          throw error;
        }
      }
      return verified?.receipt ?? null;
    },
  };
}
