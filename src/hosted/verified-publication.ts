import { createHash } from "node:crypto";
import { z } from "zod";
import { publishVerifiedPullRequest } from "../reporter/github-publisher.js";
import type { GitHubRequest, PublishInput } from "../reporter/github-publisher.js";
import { renderPullRequestReport } from "../reporter/report.js";
import { HostedCandidateSchema } from "./agent-protocol.js";
import { eligibleForTrustedVerification } from "./run-workflow.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
/** Private, in-process output of independent replay; never accepted from worker HTTP or persisted. */
export const HostedVerifiedArtifactSchema = HostedCandidateSchema.extend({
  candidateDigest: digest, workerReportDigest: digest, verifiedBaseSha: sha,
}).refine(value => {
  const ids = value.report.final.acceptedFixIds;
  return eligibleForTrustedVerification(value.report) && ids.length > 0 && value.patches.length === ids.length &&
    new Set(value.patches.map(patch => patch.taskId)).size === ids.length && value.patches.every(patch => ids.includes(patch.taskId));
}, "Verified artifact requires matching replayed patches and complete production checks");
export type HostedVerifiedArtifact = z.infer<typeof HostedVerifiedArtifactSchema>;
/** Consumes source only after the coordinator has confirmed checkout and candidate erasure. */
export type HostedVerifiedCandidateConsumer = (runId: string, artifact: HostedVerifiedArtifact, artifactDigest: string) => Promise<void>;

/** Integrity binding, not authentication: only the trusted coordinator may deliver this source artifact. */
export function hostedVerifiedArtifactDigest(artifact: HostedVerifiedArtifact): string {
  return createHash("sha256").update(JSON.stringify(HostedVerifiedArtifactSchema.parse(artifact))).digest("hex");
}

/** Caller supplies independently authorized repository metadata and the coordinator's exact artifact identity. */
export async function publishHostedVerifiedCandidate(request: GitHubRequest, options: {
  repository: string; baseBranch: string; actorLogin: string; title: string;
  candidateDigest: string; workerReportDigest: string; verifiedBaseSha: string; artifactDigest: string;
}, input: unknown) {
  const artifact = HostedVerifiedArtifactSchema.parse(input);
  if (artifact.candidateDigest !== digest.parse(options.candidateDigest) ||
    artifact.workerReportDigest !== digest.parse(options.workerReportDigest) ||
    artifact.verifiedBaseSha !== sha.parse(options.verifiedBaseSha) ||
    hostedVerifiedArtifactDigest(artifact) !== digest.parse(options.artifactDigest)) throw new Error("Trusted publication artifact identity mismatch");
  const groups: PublishInput["groups"] = artifact.patches.map(patch => {
    const task = artifact.report.outcomes.find(outcome => outcome.id === patch.taskId && outcome.status === "verified");
    if (!task) throw new Error("Verified patch lost its trusted task provenance");
    return { id: task.id, ruleId: task.ruleId, criterion: task.criterion, perPatchAccepted: true, changes: patch.changes };
  });
  return publishVerifiedPullRequest(request, {
    repository: options.repository, baseBranch: options.baseBranch, actorLogin: options.actorLogin, title: options.title,
    verifiedBaseSha: artifact.verifiedBaseSha, report: renderPullRequestReport(artifact.report), groups,
    verification: { acceptedFixIds: artifact.report.final.acceptedFixIds, failures: [], buildPassed: true },
  });
}
