import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { defaults } from "../config.js";
import { AiSdkLlmProvider, resolveApiKey } from "../llm/ai-sdk-provider.js";
import type { LlmProvider } from "../llm/types.js";
import { resolveExecutionModel } from "../llm/execution-policy.js";
import { createJsonlLlmRunObserver } from "../llm/run-record.js";
import { LlmModelConfigSchema } from "../types/schemas.js";
import { appendRunRecord } from "../tracer/run-record.js";
import { HostedPatchAgent } from "./agent-api.js";
import type { HostedPatchAgentOptions, HostedRunRecord } from "./agent-api.js";
import { createHostedAgentServer } from "./agent-http.js";
import { FirestoreHostedAgentRunStore } from "./agent-run-store.js";
import { FirestoreHostedRunStore } from "./firestore-run-store.js";
import { FirestoreHostedCheckoutRegistry } from "./checkout-registry.js";
import { FirestoreCandidateCleanupStore } from "./candidate-cleanup.js";
import { createHostedCandidateCoordinator } from "./candidate-coordinator.js";
import { createHostedCandidateTaskServer } from "./candidate-task-http.js";
import { CloudRunJobInvoker } from "./cloud-run-job.js";
import { CloudTasksRunQueue } from "./cloud-tasks-queue.js";
import { FirestoreDispatchClaims } from "./firestore-dispatch-claims.js";
import { CloudRunTaskDispatcher, createCloudRunTaskHandler } from "./task-dispatch.js";
import { CloudTasksCandidateQueue } from "./candidate-task-queue.js";
import { prepareHostedCheckout } from "./checkout.js";
import { openMonthlyHostedSpend } from "./firestore-spend-ledger.js";
import { GcsHostedCandidateStore } from "./gcs-candidate-store.js";
import { GitHubSourceAccess } from "./github-source-access.js";
import { createGoogleMetadataAccessToken, createGoogleMetadataIdentityToken } from "./google-access-token.js";
import { GoogleCloudTasksOidcVerifier } from "./google-oidc.js";
import { createHostedTrustedServices } from "./services.js";
import { HostedVerifierClient } from "./verifier-client.js";
import { createHostedWebhookServer } from "./http.js";
import { FirestoreWebhookRunRegistry } from "./webhook-registry.js";
import { assertHostedVerifierNetwork } from "./verifier-network.js";
import type { QueuedRun } from "./webhook.js";

const collection = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/);
const origin = z.string().url().refine(value => { const url = new URL(value); return url.protocol === "https:" && url.origin === value; });
const account = z.string().regex(/^[A-Za-z0-9-]+@[a-z][a-z0-9-]{4,30}[a-z0-9]\.iam\.gserviceaccount\.com$/);
const common = z.object({
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,30}[a-z0-9]$/), region: z.string().regex(/^[a-z][a-z0-9]+(?:-[a-z0-9]+)+$/),
  candidateBucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/), candidateQueueId: collection,
  candidateTaskOrigin: origin.refine(value => new URL(value).hostname.endsWith(".run.app")), verifierOrigin: origin,
  taskServiceAccountEmail: account, relayServiceAccountEmail: account,
  workRoot: z.string().refine(isAbsolute),
  collections: z.object({ agentRuns: collection, reports: collection, checkoutPins: collection, cleanup: collection, spending: collection }).strict(),
}).strict();
const trusted = common.extend({
  appId: z.number().int().positive(), repositories: z.array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)).min(1),
  model: LlmModelConfigSchema, pricing: z.object({ inputUsdPerMillion: z.number().finite().nonnegative(), outputUsdPerMillion: z.number().finite().nonnegative() }).strict(),
  maxInputTokens: z.number().int().positive().safe(), maxOutputTokens: z.number().int().positive().max(defaults.hostedMaxOutputTokens), maxCostUsdPerRun: z.number().finite().positive(),
  runtimeRoot: z.string().refine(isAbsolute),
});
const agentConfig = trusted.extend({ role: z.literal("agent"), agentOrigin: origin.refine(value => new URL(value).hostname.endsWith(".run.app")),
  jobId: collection, workerContainerName: collection, jobTaskServiceAccountEmail: account,
  collections: common.shape.collections.extend({ dispatch: collection }).strict() });
const webhookConfig = common.extend({ role: z.literal("webhook"), appId: trusted.shape.appId, repositories: trusted.shape.repositories,
  installationAllowlist: z.array(z.number().int().positive()).min(1), agentOrigin: agentConfig.shape.agentOrigin,
  jobQueueId: collection, jobTaskServiceAccountEmail: account,
  collections: common.shape.collections.extend({ webhooks: collection }).strict() });
export const HostedServiceConfigSchema = z.discriminatedUnion("role", [common.extend({ role: z.literal("relay") }),
  agentConfig, trusted.extend({ role: z.literal("verifier") }), webhookConfig]);

/** Operator configuration only. Relay holds no LLM/App key; verifier needs an actual Docker-capable trusted host. */
export function createHostedServiceRuntime(input: unknown, options: { environment?: NodeJS.ProcessEnv; fetcher?: typeof fetch; provider?: LlmProvider } = {}) {
  const config = HostedServiceConfigSchema.parse(input), environment = options.environment ?? process.env;
  if (new Set(Object.values(config.collections)).size !== Object.keys(config.collections).length) throw new Error("Hosted metadata collections must be distinct");
  if (config.taskServiceAccountEmail === config.relayServiceAccountEmail) throw new Error("Task and relay identities must be distinct");
  if ("jobTaskServiceAccountEmail" in config && ([config.taskServiceAccountEmail, config.relayServiceAccountEmail].includes(config.jobTaskServiceAccountEmail) ||
    !config.jobTaskServiceAccountEmail.endsWith("@" + config.projectId + ".iam.gserviceaccount.com"))) throw new Error("Job task identity must be distinct and belong to the selected project");
  const getAccessToken = createGoogleMetadataAccessToken(options.fetcher);
  const metadata = (collectionId: string) => ({ projectId: config.projectId, collectionId, getAccessToken, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
  const runs = new FirestoreHostedRunStore(metadata(config.collections.reports)), cleanup = new FirestoreCandidateCleanupStore(metadata(config.collections.cleanup));
  const queue = new CloudTasksCandidateQueue({ projectId: config.projectId, region: config.region, queueId: config.candidateQueueId,
    targetOrigin: config.candidateTaskOrigin, serviceAccountEmail: config.taskServiceAccountEmail, getAccessToken, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
  const candidates = new GcsHostedCandidateStore({ bucketName: config.candidateBucket, getAccessToken,
    scheduleExpiry: (runId, expiresAt) => queue.enqueueExpiry(runId, expiresAt), ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
  const oidc = new GoogleCloudTasksOidcVerifier({ audience: config.role === "verifier" ? config.verifierOrigin : config.candidateTaskOrigin,
    serviceAccountEmail: config.role === "verifier" ? config.relayServiceAccountEmail : config.taskServiceAccountEmail, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
  if (config.role === "relay") {
    const verifier = new HostedVerifierClient({ origin: config.verifierOrigin, runs,
      getIdentityToken: createGoogleMetadataIdentityToken({ audience: config.verifierOrigin, serviceAccountEmail: config.relayServiceAccountEmail,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}) }), ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
    return { role: config.role, server: createHostedCandidateTaskServer({ workflow: verifier, runs, store: candidates, cleanup,
      authenticateTask: authorization => oidc.verify(authorization), evidenceRoot: join(config.workRoot, "evidence") }) };
  }
  const sourceAccess = new GitHubSourceAccess({ appId: config.appId, privateKey: environment.ACCESSWRIGHT_GITHUB_APP_PRIVATE_KEY ?? "",
    allowlist: config.repositories, evidenceRoot: join(config.workRoot, "evidence"), ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
  if (config.role === "webhook") {
    const secret = z.string().min(1).max(defaults.configMaxBytes).parse(environment.ACCESSWRIGHT_GITHUB_WEBHOOK_SECRET);
    const runQueue = new CloudTasksRunQueue({ projectId: config.projectId, region: config.region, queueId: config.jobQueueId,
      targetUrl: config.agentOrigin + "/internal/jobs", serviceAccountEmail: config.jobTaskServiceAccountEmail, getAccessToken,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
    return { role: config.role, server: createHostedWebhookServer({ secret, installationAllowlist: new Set(config.installationAllowlist),
      repositoryAllowlist: new Set(config.repositories), registry: new FirestoreWebhookRunRegistry(metadata(config.collections.webhooks)),
      authorizeComment: context => sourceAccess.authorizeComment(context), queue: async run => {
        const directory = join(config.workRoot, "evidence", run.runId); await mkdir(directory, { recursive: true, mode: 0o700 });
        await appendRunRecord(join(directory, "run.jsonl"), { timestamp: new Date().toISOString(), step: "hosted-webhook-enqueue", status: "ok" });
        try {
          const result = await runQueue.enqueue(run);
          await appendRunRecord(join(directory, "run.jsonl"), { timestamp: new Date().toISOString(), step: "hosted-webhook-enqueued", status: "ok", metadata: { outcome: result.status } });
        } catch (error) {
          await appendRunRecord(join(directory, "run.jsonl"), { timestamp: new Date().toISOString(), step: "hosted-webhook-enqueued", status: "error" }); throw error;
        }
      } }) };
  }
  const model = resolveExecutionModel(config.model, true);
  if (config.role === "agent" && !options.provider) resolveApiKey(model, environment);
  const provider = options.provider ?? new AiSdkLlmProvider({ environment, pricing: () => config.pricing });
  const agentOptions: HostedPatchAgentOptions = { model, pricing: config.pricing, maxInputTokens: config.maxInputTokens,
    maxOutputTokens: config.maxOutputTokens, maxCostUsdPerRun: config.maxCostUsdPerRun, provider,
    providerVerification: options.provider ? "fake-provider" : "provider-api", runStore: new FirestoreHostedAgentRunStore(metadata(config.collections.agentRuns)),
    ledgerForRun: run => openMonthlyHostedSpend(metadata(config.collections.spending), run.installationId),
    observeCall: createJsonlLlmRunObserver(join(config.workRoot, "evidence")) };
  const checkouts = new FirestoreHostedCheckoutRegistry(metadata(config.collections.checkoutPins));
  const identity = (run: Pick<HostedRunRecord, "runId" | "repository" | "installationId">) => ({ runId: run.runId, repository: run.repository, installationId: run.installationId });
  const pinOriginalRevision = (run: QueuedRun) => sourceAccess.pinRunRevision(identity(run), run.pullNumber);
  const scheduleVerification = (runId: string, reportDigest: string) => queue.enqueueVerification(runId, reportDigest);
  const evidenceRoot = join(config.workRoot, "evidence"), tempRoot = join(config.workRoot, "temporary");
  if (config.role === "verifier") {
    const service = createHostedTrustedServices({ agent: agentOptions, runs, checkouts, sourceAccess: {
      getInstallationToken: async source => {
        await mkdir(join(evidenceRoot, source.runId), { recursive: true, mode: 0o700 });
        try {
          await assertHostedVerifierNetwork();
          await appendRunRecord(join(evidenceRoot, source.runId, "run.jsonl"), { timestamp: new Date().toISOString(), step: "hosted-verifier-network-isolation", status: "ok" });
        } catch (error) {
          await appendRunRecord(join(evidenceRoot, source.runId, "run.jsonl"), { timestamp: new Date().toISOString(), step: "hosted-verifier-network-isolation", status: "error" }); throw error;
        }
        return sourceAccess.getInstallationToken(source);
      },
    }, candidates, cleanup, pinOriginalRevision, scheduleVerification,
      authenticateTask: authorization => oidc.verify(authorization), evidenceRoot, tempRoot, runtimeRoot: config.runtimeRoot });
    return { role: config.role, server: service.taskServer };
  }
  const agent = new HostedPatchAgent(agentOptions);
  const coordinator = createHostedCandidateCoordinator({ agent, store: candidates, cleanup, evidenceRoot, scheduleVerification,
    resolveCheckout: () => Promise.reject(new Error("Scheduled verification requires the separate trusted Docker host")) });
  const claims = new FirestoreDispatchClaims(metadata(config.collections.dispatch));
  const jobs = new CloudRunJobInvoker({ projectId: config.projectId, region: config.region, jobId: config.jobId,
    containerName: config.workerContainerName, getAccessToken, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
  const jobOidc = new GoogleCloudTasksOidcVerifier({ audience: config.agentOrigin, serviceAccountEmail: config.jobTaskServiceAccountEmail,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
  const recordDispatch = async (runId: string, step: string, status: "ok" | "rejected" | "error") => {
    const directory = join(evidenceRoot, runId); await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendRunRecord(join(directory, "run.jsonl"), { timestamp: new Date().toISOString(), step, status });
  };
  const registerRunToken = async (run: QueuedRun) => {
    const source = identity(run); await checkouts.register({ ...source, verifiedBaseSha: await pinOriginalRevision(run) }); return agent.registerRun(source);
  };
  const dispatcher = new CloudRunTaskDispatcher({ authenticateTask: authorization => jobOidc.verify(authorization), registerRunToken,
    claim: async run => { const claimed = await claims.claim(run); await recordDispatch(run.runId, "hosted-job-claim", claimed ? "ok" : "rejected"); return claimed; },
    invokeJob: async (run, token) => { await recordDispatch(run.runId, "hosted-job-invocation", "ok"); return jobs.start(run, token); },
    recordOutcome: async (run, operation) => { await claims.recordOutcome(run, operation); await recordDispatch(run.runId, "hosted-job-outcome", operation ? "ok" : "error"); } });
  return { role: config.role,
    registerRunToken,
    server: createHostedAgentServer({ agent, store: runs, ...coordinator, finishScheduled: true, dispatchJobs: createCloudRunTaskHandler(dispatcher), input: { evidenceRoot,
      resolveCheckout: async run => {
        const source = identity(run), pin = await checkouts.resolve(source), installationToken = await sourceAccess.getInstallationToken(source);
        return prepareHostedCheckout({ ...source, verifiedBaseSha: pin.verifiedBaseSha, installationToken, evidenceRoot, tempRoot, runtimeRoot: config.runtimeRoot });
      } } }),
  };
}

export async function runHostedServiceEntry(): Promise<void> {
  const raw = process.env.ACCESSWRIGHT_HOSTED_CONFIG;
  if (!raw || Buffer.byteLength(raw) > defaults.configMaxBytes) throw new Error("Bounded operator service configuration is required");
  const config = HostedServiceConfigSchema.parse(JSON.parse(raw) as unknown);
  if (config.role === "verifier") await assertHostedVerifierNetwork();
  const service = createHostedServiceRuntime(config);
  const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? defaults.hostedServicePort);
  const evidenceRoot = join(config.workRoot, "evidence");
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  try {
    service.server.listen(port, "0.0.0.0"); await once(service.server, "listening");
    await appendRunRecord(join(evidenceRoot, "service.jsonl"), { timestamp: new Date().toISOString(), step: "hosted-service-start", status: "ok", metadata: { role: service.role } });
  } catch (error) {
    await new Promise<void>(done => service.server.close(() => done())); throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runHostedServiceEntry(); }
  catch { console.error("Hosted service failed; inspect operator configuration and run metadata"); process.exitCode = 1; }
}
