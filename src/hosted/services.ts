import { createJsonlLlmRunObserver } from "../llm/run-record.js";
import { HostedPatchAgent } from "./agent-api.js";
import type { HostedPatchAgentOptions, HostedRunRecord } from "./agent-api.js";
import { createHostedAgentServer } from "./agent-http.js";
import { createHostedCandidateCoordinator } from "./candidate-coordinator.js";
import { createHostedCandidateTaskServer } from "./candidate-task-http.js";
import type { FirestoreCandidateCleanupStore } from "./candidate-cleanup.js";
import type { FirestoreHostedCheckoutRegistry } from "./checkout-registry.js";
import { prepareHostedCheckout } from "./checkout.js";
import type { GcsHostedCandidateStore } from "./gcs-candidate-store.js";
import type { GitHubSourceAccess } from "./github-source-access.js";
import { HostedRunWorkflow } from "./run-workflow.js";
import type { HostedRunStore } from "./run-workflow.js";
import type { QueuedRun } from "./webhook.js";
import type { HostedVerifiedCandidateConsumer } from "./verified-publication.js";

/** Trusted host only: separate worker and task ingress, shared durable identities and original source pins. */
export function createHostedTrustedServices(options: {
  agent: HostedPatchAgentOptions;
  runs: HostedRunStore;
  checkouts: Pick<FirestoreHostedCheckoutRegistry, "register" | "resolve">;
  sourceAccess: Pick<GitHubSourceAccess, "getInstallationToken">;
  candidates: Pick<GcsHostedCandidateStore, "put" | "get" | "remove" | "generationForCleanup">;
  cleanup: Pick<FirestoreCandidateCleanupStore, "claim" | "confirm" | "get">;
  /** Resolve the authorized event's original revision; PR runs must not silently use the default branch. */
  pinOriginalRevision: (run: QueuedRun) => Promise<string>;
  scheduleVerification: (runId: string, reportDigest: string) => Promise<void>;
  authenticateTask: (authorization: string) => Promise<boolean>;
  /** Trusted-only consumer; deployment must separately authorize repository writes. */
  onVerifiedCandidate?: HostedVerifiedCandidateConsumer;
  tempRoot: string;
  runtimeRoot: string;
  evidenceRoot: string;
}) {
  const agent = new HostedPatchAgent({ ...options.agent, observeCall: createJsonlLlmRunObserver(options.evidenceRoot) });
  const identity = (run: Pick<HostedRunRecord, "runId" | "repository" | "installationId">) => ({
    runId: run.runId, repository: run.repository, installationId: run.installationId,
  });
  const resolveCheckout = async (run: Pick<HostedRunRecord, "runId" | "repository" | "installationId">) => {
    const source = identity(run), pin = await options.checkouts.resolve(source);
    const installationToken = await options.sourceAccess.getInstallationToken(source);
    return prepareHostedCheckout({ ...source, verifiedBaseSha: pin.verifiedBaseSha, installationToken,
      tempRoot: options.tempRoot, runtimeRoot: options.runtimeRoot, evidenceRoot: options.evidenceRoot });
  };
  const coordinator = createHostedCandidateCoordinator({ agent, store: options.candidates, cleanup: options.cleanup,
    evidenceRoot: options.evidenceRoot, scheduleVerification: options.scheduleVerification,
    ...(options.onVerifiedCandidate ? { onVerifiedCandidate: options.onVerifiedCandidate } : {}),
    resolveCheckout: async runId => {
      const run = await options.agent.runStore.get(runId);
      if (!run) throw new Error("Trusted source run identity is unavailable");
      return resolveCheckout(run.record);
    },
  });
  const workflow = new HostedRunWorkflow({ store: options.runs, ...coordinator,
    authenticate: (runId, token) => agent.inspectRun(runId, token) });
  return {
    agentServer: createHostedAgentServer({ agent, store: options.runs, ...coordinator,
      input: { resolveCheckout, evidenceRoot: options.evidenceRoot } }),
    taskServer: createHostedCandidateTaskServer({ authenticateTask: options.authenticateTask, workflow,
      runs: options.runs, store: options.candidates, cleanup: options.cleanup, evidenceRoot: options.evidenceRoot }),
    registerRunToken: async (run: QueuedRun) => {
      const source = identity(run);
      await options.checkouts.register({ ...source, verifiedBaseSha: await options.pinOriginalRevision(run) });
      return agent.registerRun(source);
    },
  };
}
