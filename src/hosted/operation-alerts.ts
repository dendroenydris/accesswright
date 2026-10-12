import { z } from "zod";

import { defaults } from "../config.js";

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const amount = z.number().finite().nonnegative();
const jobSchema = z.object({
  runId: identity,
  status: z.enum(["succeeded", "failed", "running", "unknown"]),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
}).strict().refine(job => (job.status === "succeeded" || job.status === "failed") === (job.finishedAt !== null) &&
  (job.finishedAt === null || Date.parse(job.finishedAt) >= Date.parse(job.startedAt)), "Invalid terminal job evidence");
const callSchema = z.object({
  id: identity,
  recordedAt: z.iso.datetime(),
  state: z.enum(["settled", "pending", "unknown"]),
  costUsd: amount.nullable(),
}).strict().refine(call => (call.state === "settled") === (call.costUsd !== null), "Only settled calls have known cost");

export const OperationSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  observedAt: z.iso.datetime(),
  complete: z.object({ jobs: z.boolean(), calls: z.boolean() }).strict(),
  jobs: z.array(jobSchema).max(defaults.operationMaxRecords),
  calls: z.array(callSchema).max(defaults.operationMaxRecords),
}).strict().superRefine((snapshot, context) => {
  const start = Date.parse(snapshot.day + "T00:00:00.000Z"), end = start + 86400000;
  const observed = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== snapshot.day || observed < start || observed > end) {
    context.addIssue({ code: "custom", message: "Observation must be inside the selected UTC day or its closing midnight" });
  }
  if (new Set(snapshot.jobs.map(job => job.runId)).size !== snapshot.jobs.length ||
    new Set(snapshot.calls.map(call => call.id)).size !== snapshot.calls.length) {
    context.addIssue({ code: "custom", message: "Duplicate job or provider-call identity" });
  }
  for (const job of snapshot.jobs) {
    if (Date.parse(job.startedAt) > observed || (job.finishedAt !== null &&
      (Date.parse(job.finishedAt) < start || Date.parse(job.finishedAt) >= end || Date.parse(job.finishedAt) > observed))) {
      context.addIssue({ code: "custom", message: "Job evidence is outside the observation window" });
    }
  }
  for (const call of snapshot.calls) {
    const time = Date.parse(call.recordedAt);
    if (time < start || time >= end || time > observed) context.addIssue({ code: "custom", message: "Call evidence is outside the observation window" });
  }
});

export const OperationAlertPolicySchema = z.object({
  failureRate: amount.max(1),
  dailyCostUsd: amount,
  p95DurationMs: z.number().finite().positive(),
  minimumCompletedJobs: z.number().int().positive(),
}).strict();

/** Trusted terminal job results and settled call metadata only; never launch acknowledgments or worker flags. */
export function evaluateOperationAlerts(rawSnapshot: unknown, rawPolicy: unknown) {
  const snapshot = OperationSnapshotSchema.parse(rawSnapshot), policy = OperationAlertPolicySchema.parse(rawPolicy);
  const completed = snapshot.jobs.filter(job => job.finishedAt !== null);
  const failed = completed.filter(job => job.status === "failed").length;
  const unknownJobs = snapshot.jobs.filter(job => job.status === "unknown").length;
  const unsettledCalls = snapshot.calls.filter(call => call.state !== "settled").length;
  const durations = completed.map(job => Date.parse(job.finishedAt ?? "") - Date.parse(job.startedAt)).sort((a, b) => a - b);
  const failureRate = completed.length === 0 ? null : failed / completed.length;
  const p95DurationMs = durations[Math.ceil(durations.length * 0.95) - 1] ?? null;
  const settledUsd = amount.parse(snapshot.calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0));
  const enoughJobs = snapshot.complete.jobs && unknownJobs === 0 && completed.length >= policy.minimumCompletedJobs;
  return {
    schemaVersion: 1, day: snapshot.day, observedAt: snapshot.observedAt,
    complete: snapshot.complete, policy,
    completedJobs: completed.length, failedJobs: failed,
    runningJobs: snapshot.jobs.filter(job => job.status === "running").length,
    unknownJobs, unsettledCalls, failureRate, p95DurationMs, settledUsd,
    alerts: {
      failureRate: !enoughJobs ? "insufficient-data" : (failureRate ?? 0) > policy.failureRate ? "breached" : "ok",
      dailyCostUsd: settledUsd > policy.dailyCostUsd ? "breached" : !snapshot.complete.calls || unsettledCalls > 0 ? "insufficient-data" : "ok",
      p95DurationMs: !enoughJobs ? "insufficient-data" : (p95DurationMs ?? 0) > policy.p95DurationMs ? "breached" : "ok",
    },
  };
}
