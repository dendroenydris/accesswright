import { HostedCandidateSchema, hostedCandidateDigest } from "../../src/hosted/agent-protocol.js";
import type { HostedCandidate } from "../../src/hosted/agent-protocol.js";
import { hostedReportDigest } from "../../src/hosted/run-workflow.js";
import type { HostedVerifiedCandidate } from "../../src/hosted/trusted-verifier.js";

export function hostedCandidateFixture() {
  return HostedCandidateSchema.parse({
    report: { schemaVersion: 1, startedAt: "2026-10-11T01:00:00.000Z", finishedAt: "2026-10-11T01:01:00.000Z", durationMs: 60000,
      status: "verified", applied: false, fixed: 1, rejected: 0, needsHuman: 0, ignored: 0, attempts: 1,
      providerVerification: "not-run", unknownUsage: false, usage: { inputTokens: 0, outputTokens: 0, spentUsd: 0 },
      checks: ["build", "typecheck", "lint", "tests"].map(check => ({ check, status: "passed", available: true, exitCode: 0, durationMs: 1, failureIds: [] })),
      outcomes: [{ id: "id-1", ruleId: "button-name", criterion: "4.1.2", route: "llm", status: "verified", reason: null }],
      final: { acceptedFixIds: ["id-1"], droppedFixIds: [], failures: [] } },
    patches: [{ taskId: "id-1", changes: [{ path: "Button.tsx", before: "private-source-marker", after: "private-repaired-marker" }] }],
  });
}

export function hostedVerifiedCandidateFixture(candidate: HostedCandidate, verifiedBaseSha: string): HostedVerifiedCandidate {
  const reportDigest = hostedReportDigest(candidate.report);
  return { receipt: { reportDigest, verifiedBaseSha }, artifact: {
    ...structuredClone(candidate), candidateDigest: hostedCandidateDigest(candidate), workerReportDigest: reportDigest, verifiedBaseSha,
  } };
}
