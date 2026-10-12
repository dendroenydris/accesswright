#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaults } from "../config.js";
import { isMainModule } from "../entrypoint.js";
import { appendRunRecord } from "../tracer/run-record.js";
import { CloudRunJobInvoker } from "./cloud-run-job.js";
import type { CloudRunExecutionObservation } from "./cloud-run-job.js";
import { FirestoreDispatchClaims } from "./firestore-dispatch-claims.js";
import { createGoogleMetadataAccessToken } from "./google-access-token.js";
import { HostedServiceConfigSchema } from "./service-entry.js";

/** Reads the trusted launch claim and actual execution; never calls Jobs.run or changes a claim. */
export async function readHostedExecution(input: unknown, id: string, options: { fetcher?: typeof fetch } = {}): Promise<CloudRunExecutionObservation> {
  const config = HostedServiceConfigSchema.parse(input), runId = z.string().regex(/^[a-f0-9]{32}$/).parse(id);
  if (config.role !== "agent" || new Set(Object.values(config.collections)).size !== Object.keys(config.collections).length) {
    throw new Error("Execution observation requires the agent's distinct metadata configuration");
  }
  const getAccessToken = createGoogleMetadataAccessToken(options.fetcher);
  const claims = new FirestoreDispatchClaims({ projectId: config.projectId, collectionId: config.collections.dispatch, getAccessToken, ...options });
  const jobs = new CloudRunJobInvoker({ projectId: config.projectId, region: config.region, jobId: config.jobId,
    containerName: config.workerContainerName, getAccessToken, ...options });
  const directory = join(config.workRoot, "evidence", runId), record = join(directory, "run.jsonl");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendRunRecord(record, { timestamp: new Date().toISOString(), step: "hosted-execution-read-start", status: "ok" });
  try {
    const claim = await claims.read(runId);
    const unknown: CloudRunExecutionObservation = { runId, operation: null, execution: null, status: "unknown",
      observedAt: new Date().toISOString(), startedAt: null, finishedAt: null };
    let result = unknown;
    if (claim) {
      if (!config.repositories.some(repository => repository.toLowerCase() === claim.repository.toLowerCase())) throw new Error("Execution repository is outside the configured scope");
      if (claim.status === "launched" && claim.operation) {
        result = await jobs.inspectExecution({ runId: claim.runId, repository: claim.repository, installationId: claim.installationId,
          event: claim.event, createdAt: claim.createdAt, pullNumber: claim.pullNumber }, claim.operation);
      }
    }
    await appendRunRecord(record, { timestamp: result.observedAt, step: "hosted-execution-read-result",
      status: result.status === "unknown" ? "skipped" : "ok", metadata: { outcome: result.status } });
    return result;
  } catch (error) {
    await appendRunRecord(record, { timestamp: new Date().toISOString(), step: "hosted-execution-read-result", status: "error" });
    throw error;
  }
}

export async function runHostedExecutionCli(args: readonly string[], environment: NodeJS.ProcessEnv = process.env, options: { fetcher?: typeof fetch } = {}) {
  if (args.length !== 2 || args[0] !== "--run-id" || !/^[a-f0-9]{32}$/.test(args[1])) throw new Error("Expected --run-id <32-character hexadecimal ID>");
  const raw = environment.ACCESSWRIGHT_HOSTED_CONFIG;
  if (!raw || Buffer.byteLength(raw) > defaults.configMaxBytes) throw new Error("Bounded operator service configuration is required");
  return readHostedExecution(JSON.parse(raw) as unknown, args[1], options);
}

if (await isMainModule(import.meta.url)) {
  runHostedExecutionCli(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.status === "succeeded" || result.status === "failed" ? 0 : 1;
  }).catch(() => {
    process.stderr.write("Execution observation is unconfirmed; check operator configuration, identity and metadata access\n");
    process.exitCode = 2;
  });
}
