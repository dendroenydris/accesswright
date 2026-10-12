import { expect, it } from "vitest";

import { evaluateOperationAlerts } from "../../src/hosted/operation-alerts.js";

const policy = { failureRate: 0.2, dailyCostUsd: 1, p95DurationMs: 1000, minimumCompletedJobs: 2 };
const snapshot = {
  schemaVersion: 1, day: "2026-10-12", observedAt: "2026-10-13T00:00:00.000Z",
  complete: { jobs: true, calls: true }, jobs: [], calls: [],
};
function job(id: string, durationMs: number, failed = false) {
  const start = Date.parse("2026-10-12T01:00:00.000Z");
  return { runId: id, status: failed ? "failed" : "succeeded", startedAt: new Date(start).toISOString(), finishedAt: new Date(start + durationMs).toISOString() };
}
const call = { id: "call-1", recordedAt: "2026-10-12T01:01:00.000Z", state: "settled", costUsd: 0.75 };

it("calculates terminal-job failure rate, nearest-rank p95 and settled costs once per identity", () => {
  const result = evaluateOperationAlerts({ ...snapshot,
    jobs: Array.from({ length: 20 }, (_, index) => job("job-" + index, (index + 1) * 100, index < 5)),
    calls: [call, { ...call, id: "call-2" }],
  }, policy);
  expect(result).toMatchObject({ completedJobs: 20, failedJobs: 5, failureRate: 0.25, p95DurationMs: 1900, settledUsd: 1.5,
    alerts: { failureRate: "breached", dailyCostUsd: "breached", p95DurationMs: "breached" } });
  expect(JSON.stringify(result)).not.toMatch(/call-1|job-1|runId|recordedAt|source|token/);
});

it("does not treat running jobs, launch acknowledgments or unknown outcomes as successful terminal results", () => {
  const running = { runId: "pending", status: "running", startedAt: "2026-10-11T01:00:00.000Z", finishedAt: null };
  const result = evaluateOperationAlerts({ ...snapshot, jobs: [running] }, policy);
  expect(result).toMatchObject({ completedJobs: 0, runningJobs: 1, failureRate: null, p95DurationMs: null,
    alerts: { failureRate: "insufficient-data", p95DurationMs: "insufficient-data", dailyCostUsd: "ok" } });
  const unknown = evaluateOperationAlerts({ ...snapshot, jobs: [job("one", 10), job("two", 10), { ...running, status: "unknown" }] }, policy);
  expect(unknown.alerts.failureRate).toBe("insufficient-data");
  expect(unknown.alerts.p95DurationMs).toBe("insufficient-data");
  expect(() => evaluateOperationAlerts({ ...snapshot, jobs: [{ ...running, status: "launched" }] }, policy)).toThrow();
  expect(() => evaluateOperationAlerts({ ...snapshot, jobs: [{ ...running, status: "succeeded" }] }, policy)).toThrow();
});

it("withholds healthy alerts for partial data or unknown usage but retains breached known cost", () => {
  const base = { ...snapshot, jobs: [job("one", 2000, true), job("two", 2000, true)], calls: [call],
    complete: { jobs: false, calls: false } };
  expect(evaluateOperationAlerts(base, policy).alerts).toEqual({ failureRate: "insufficient-data", p95DurationMs: "insufficient-data", dailyCostUsd: "insufficient-data" });
  const uncertain = { ...snapshot, jobs: [job("one", 10), job("two", 10)], calls: [{ ...call, state: "unknown", costUsd: null }] };
  expect(evaluateOperationAlerts(uncertain, policy)).toMatchObject({ unsettledCalls: 1, settledUsd: 0, alerts: { dailyCostUsd: "insufficient-data" } });
  expect(evaluateOperationAlerts({ ...uncertain, calls: [call, { ...call, id: "two", costUsd: 0.75 }, { ...call, id: "unknown", state: "pending", costUsd: null }] }, policy).alerts.dailyCostUsd).toBe("breached");
  expect(() => evaluateOperationAlerts({ ...uncertain, calls: [{ ...call, reservedUsd: 15 }] }, policy)).toThrow();
  expect(() => evaluateOperationAlerts({ ...uncertain, calls: [{ ...call, state: "unknown" }] }, policy)).toThrow();
});

it("uses strict greater-than thresholds and the operator's minimum sample size", () => {
  const data = { ...snapshot, jobs: [job("one", 1000, true), job("two", 1000)], calls: [{ ...call, costUsd: 1 }] };
  expect(evaluateOperationAlerts(data, { ...policy, failureRate: 0.5 }).alerts).toEqual({ failureRate: "ok", p95DurationMs: "ok", dailyCostUsd: "ok" });
  expect(evaluateOperationAlerts(data, { ...policy, minimumCompletedJobs: 3 }).alerts.failureRate).toBe("insufficient-data");
  expect(() => evaluateOperationAlerts(data, { ...policy, minimumCompletedJobs: 0 })).toThrow();
  expect(() => evaluateOperationAlerts(data, { ...policy, failureRate: 1.1 })).toThrow();
  expect(() => evaluateOperationAlerts(data, {})).toThrow();
});

it("accepts a job crossing UTC midnight by its completion day and counts calls by their own recording time", () => {
  const crossing = { runId: "crossing", status: "succeeded", startedAt: "2026-10-11T23:59:59.000Z", finishedAt: "2026-10-12T00:00:01.000Z" };
  expect(evaluateOperationAlerts({ ...snapshot, jobs: [crossing], calls: [{ ...call, recordedAt: "2026-10-12T00:00:00.000Z" }] }, policy))
    .toMatchObject({ p95DurationMs: 2000, settledUsd: 0.75 });
  for (const timestamp of ["2026-10-11T23:59:59.999Z", "2026-10-13T00:00:00.000Z"]) {
    expect(() => evaluateOperationAlerts({ ...snapshot, calls: [{ ...call, recordedAt: timestamp }] }, policy)).toThrow(/window/);
  }
  expect(() => evaluateOperationAlerts({ ...snapshot, day: "2026-02-30" }, policy)).toThrow();
  expect(() => evaluateOperationAlerts({ ...snapshot, observedAt: "2026-10-12T01:00:00.000Z", calls: [call] }, policy)).toThrow(/window/);
  expect(() => evaluateOperationAlerts({ ...snapshot, jobs: [{ ...crossing, finishedAt: "2026-10-11T23:59:58.000Z" }] }, policy)).toThrow();
});

it("rejects duplicate, nonfinite or private metadata instead of silently dropping it", () => {
  expect(() => evaluateOperationAlerts({ ...snapshot, jobs: [job("same", 1), job("same", 1)] }, policy)).toThrow(/Duplicate/);
  expect(() => evaluateOperationAlerts({ ...snapshot, calls: [call, call] }, policy)).toThrow(/Duplicate/);
  expect(() => evaluateOperationAlerts({ ...snapshot, calls: [{ ...call, costUsd: Infinity }] }, policy)).toThrow();
  expect(() => evaluateOperationAlerts({ ...snapshot, calls: [{ ...call, costUsd: -1 }] }, policy)).toThrow();
  expect(() => evaluateOperationAlerts({ ...snapshot, calls: [{ ...call, costUsd: Number.MAX_VALUE }, { ...call, id: "two", costUsd: Number.MAX_VALUE }] }, policy)).toThrow();
  expect(() => evaluateOperationAlerts({ ...snapshot, source: "private source" }, policy)).toThrow();
  expect(() => evaluateOperationAlerts({ ...snapshot, jobs: [{ ...job("one", 1), workerVerified: true }] }, policy)).toThrow();
});
