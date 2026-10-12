#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaults } from "../config.js";
import { isMainModule } from "../entrypoint.js";
import { appendRunRecord } from "../tracer/run-record.js";
import { CloudRunJobInvoker } from "./cloud-run-job.js";
import { FirestoreDispatchClaims } from "./firestore-dispatch-claims.js";
import { FirestoreSpendLedger } from "./firestore-spend-ledger.js";
import { createGoogleMetadataAccessToken } from "./google-access-token.js";
import { OperationSnapshotSchema } from "./operation-alerts.js";
import { HostedServiceConfigSchema } from "./service-entry.js";

/** Read-only collection of a closed UTC day; credentials and private ledger fields never enter output. */
export async function collectHostedOperations(input: unknown, day: string, options: { fetcher?: typeof fetch } = {}) {
  const config = HostedServiceConfigSchema.parse(input), readTime = new Date().toISOString();
  const start = Date.parse(day + "T00:00:00.000Z"), end = start + 86400000;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== day || end > Date.parse(readTime)) {
    throw new Error("Operation collection requires a closed UTC day");
  }
  if (config.role !== "agent" || new Set(Object.values(config.collections)).size !== Object.keys(config.collections).length) {
    throw new Error("Operation collection requires the agent's distinct metadata configuration");
  }
  const getAccessToken = createGoogleMetadataAccessToken(options.fetcher);
  const claims = new FirestoreDispatchClaims({ projectId: config.projectId, collectionId: config.collections.dispatch, getAccessToken, ...options });
  const jobs = new CloudRunJobInvoker({ projectId: config.projectId, region: config.region, jobId: config.jobId,
    containerName: config.workerContainerName, getAccessToken, ...options });
  const directory = join(config.workRoot, "evidence", "operations", day), record = join(directory, "run.jsonl");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendRunRecord(record, { timestamp: readTime, step: "hosted-operations-collect-start", status: "ok" });
  try {
    const inventory = await claims.records(readTime);
    await appendRunRecord(record, { timestamp: new Date().toISOString(), step: "hosted-operations-claims-read", status: "ok", metadata: { count: inventory.length } });
    const usage = await FirestoreSpendLedger.observeCollection({ projectId: config.projectId, collectionId: config.collections.spending, getAccessToken, ...options }, readTime);
    await appendRunRecord(record, { timestamp: new Date().toISOString(), step: "hosted-operations-usage-read", status: usage.reconciled ? "ok" : "skipped", metadata: { count: usage.reservations.length } });
    const observedJobs: z.infer<typeof OperationSnapshotSchema>["jobs"] = [];
    const operations = new Set<string>(), observedExecutions = new Set<string>();
    let unresolvedJobs = 0, excludedJobs = 0;
    for (const claim of inventory) {
      if (Date.parse(claim.createdAt) > Date.parse(readTime) || !config.repositories.some(repository => repository.toLowerCase() === claim.repository.toLowerCase())) {
        throw new Error("Dispatch inventory has an unconfirmed timestamp or repository scope");
      }
      if (Date.parse(claim.createdAt) >= end) { excludedJobs += 1; continue; }
      if (claim.status !== "launched" || !claim.operation) { unresolvedJobs += 1; continue; }
      if (operations.has(claim.operation)) throw new Error("Repeated execution operation in dispatch inventory");
      operations.add(claim.operation);
      const run = { runId: claim.runId, repository: claim.repository, installationId: claim.installationId,
        event: claim.event, createdAt: claim.createdAt, pullNumber: claim.pullNumber };
      try {
        const observation = await jobs.inspectExecution(run, claim.operation);
        await appendRunRecord(record, { timestamp: observation.observedAt, step: "hosted-operations-execution-read",
          status: observation.status === "unknown" ? "skipped" : "ok", metadata: { outcome: observation.status } });
        if (!observation.startedAt || Date.parse(observation.startedAt) < Date.parse(claim.createdAt) ||
          Date.parse(observation.startedAt) > Date.parse(observation.observedAt)) { unresolvedJobs += 1; continue; }
        if (Date.parse(observation.startedAt) >= end || (observation.finishedAt !== null &&
          (Date.parse(observation.finishedAt) < start || Date.parse(observation.finishedAt) >= end))) { excludedJobs += 1; continue; }
        if (observation.status === "unknown") unresolvedJobs += 1;
        observedJobs.push({ runId: claim.runId, status: observation.status, startedAt: observation.startedAt, finishedAt: observation.finishedAt });
        if (observation.execution !== null) observedExecutions.add(observation.execution);
      } catch {
        unresolvedJobs += 1;
        await appendRunRecord(record, { timestamp: new Date().toISOString(), step: "hosted-operations-execution-read", status: "error" });
      }
    }
    let executionInventory: Awaited<ReturnType<CloudRunJobInvoker["listExecutionInventory"]>> | null = null;
    try {
      executionInventory = await jobs.listExecutionInventory();
      await appendRunRecord(record, { timestamp: executionInventory.observedAt, step: "hosted-operations-inventory-read", status: "ok",
        metadata: { count: executionInventory.executions.length } });
    } catch {
      executionInventory = null;
      await appendRunRecord(record, { timestamp: new Date().toISOString(), step: "hosted-operations-inventory-read", status: "error" });
    }
    const listedNames = new Set(executionInventory?.executions.map(execution => execution.name));
    const unmatchedExecutionIds = executionInventory === null ? null : executionInventory.executions.filter(execution =>
      Date.parse(execution.createTime) < end && (execution.startTime === undefined || Date.parse(execution.startTime) < end) &&
      (execution.completionTime === undefined || (Date.parse(execution.completionTime) >= start && Date.parse(execution.completionTime) < end)) &&
      !observedExecutions.has(execution.name)).map(execution => execution.name);
    const missingExecutionIds = executionInventory === null ? null : [...observedExecutions].filter(name => !listedNames.has(name));
    const unsettledBeforeClose = usage.reservations.filter(call => call.state !== "settled" && Date.parse(call.createdAt) < end).length;
    const selectedMonthPolicyPresent = usage.globalMonths.includes(day.slice(0, 7));
    const snapshot = OperationSnapshotSchema.parse({ schemaVersion: 1, day, observedAt: new Date().toISOString(),
      // shortcut: paginated resource lists do not prove historical retention; require independent window coverage before healthy job alerts.
      complete: { jobs: false, calls: usage.reconciled && selectedMonthPolicyPresent && !usage.historicalUsageUnknown && unsettledBeforeClose === 0 },
      jobs: observedJobs,
      calls: usage.reservations.filter(call => Date.parse(call.recordedAt) >= start && Date.parse(call.recordedAt) < end)
        .map(call => ({ id: call.id, recordedAt: call.recordedAt, state: call.state, costUsd: call.costUsd })),
    });
    const coverage = { readTime, claims: inventory.length, unresolvedJobs, excludedJobs, jobInventory: "unverified-retention" as const,
      executionInventory: { observedAt: executionInventory?.observedAt ?? null, listed: executionInventory?.executions.length ?? null,
        unmatchedExecutionIds, missingExecutionIds },
      reservations: usage.reservations.length, unsettledBeforeClose, accountingConsistent: usage.reconciled,
      historicalUsageUnknown: usage.historicalUsageUnknown, selectedMonthPolicyPresent };
    await appendRunRecord(record, { timestamp: snapshot.observedAt, step: "hosted-operations-collect-result", status: "skipped",
      metadata: { jobsComplete: snapshot.complete.jobs, callsComplete: snapshot.complete.calls, unresolvedJobs, unsettledBeforeClose } });
    return { snapshot, coverage };
  } catch (error) {
    await appendRunRecord(record, { timestamp: new Date().toISOString(), step: "hosted-operations-collect-result", status: "error" }); throw error;
  }
}

export async function runHostedOperationCollectCli(args: readonly string[], environment: NodeJS.ProcessEnv = process.env, options: { fetcher?: typeof fetch } = {}) {
  if (args.length !== 2 || args[0] !== "--day") throw new Error("Expected --day <closed YYYY-MM-DD UTC date>");
  const raw = environment.ACCESSWRIGHT_HOSTED_CONFIG;
  if (!raw || Buffer.byteLength(raw) > defaults.configMaxBytes) throw new Error("Bounded operator service configuration is required");
  return collectHostedOperations(JSON.parse(raw) as unknown, args[1], options);
}

if (await isMainModule(import.meta.url)) {
  runHostedOperationCollectCli(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.snapshot.complete.jobs && result.snapshot.complete.calls ? 0 : 1;
  }).catch(() => {
    process.stderr.write("Operation collection is unconfirmed; check closed date, metadata scopes and read access\n"); process.exitCode = 2;
  });
}
