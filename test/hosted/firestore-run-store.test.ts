import { expect, it } from "vitest";

import { FirestoreHostedRunStore } from "../../src/hosted/firestore-run-store.js";
import { HostedRunWorkflow } from "../../src/hosted/run-workflow.js";
import type { StoredRunResult, TrustedRunReceipt } from "../../src/hosted/run-workflow.js";
import { createFakeFirestore } from "../helpers/fake-firestore.js";
import { hostedCandidateFixture } from "../helpers/hosted-candidate.js";

const record: StoredRunResult = {
  runId: "run-1",
  repository: "owner/private-app",
  installationId: 42,
  reportDigest: "a".repeat(64),
  status: "recorded",
  acceptedFixes: 1,
  eligibleForReview: true,
  failedChecks: [],
  unknownUsage: false,
  spentUsd: 0,
  verifiedBaseSha: null,
  recordedAt: "2026-10-09T12:00:00.000Z",
};

function fixture() {
  const f = createFakeFirestore("accesswrightRuns");
  return { ...f, open: () => new FirestoreHostedRunStore(f.options) };
}

it("persists metadata across independent service instances using fixed Firestore origin", async () => {
  const f = fixture();
  const a = f.open(), b = f.open();
  expect(await a.get("run-1")).toBeUndefined();
  expect(await a.insert(record)).toEqual(record);
  expect(await b.get("run-1")).toEqual(record);
  expect(await b.update("run-1", previous => ({
    ...previous, status: "ready-for-review", verifiedBaseSha: "b".repeat(40),
  }))).toMatchObject({ status: "ready-for-review", verifiedBaseSha: "b".repeat(40) });
  expect((await a.get("run-1"))?.status).toBe("ready-for-review");
  expect(f.calls.some(call => call.method === "PATCH" && call.precondition?.startsWith("2026-"))).toBe(true);
  expect(JSON.stringify([...f.records.values()])).not.toContain("local-fixture-identity");
  await expect(a.insert(record)).rejects.toThrow(/conflict|exists/i);
});

it("never overwrites conflicting concurrent results or silently retries Firestore writes", async () => {
  const f = fixture(), store = f.open();
  await store.insert(record);
  const outcomes = await Promise.allSettled([
    store.update("run-1", current => ({ ...current, status: "ready-for-review", verifiedBaseSha: "c".repeat(40) })),
    store.update("run-1", current => ({ ...current, status: "blocked" })),
  ]);
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
  expect((await store.get("run-1"))?.status).not.toBe("recorded");
});

it("rejects mutated run identities and invalid Firestore project configuration", async () => {
  const store = fixture().open();
  await store.insert(record);
  await expect(store.update("run-1", current => ({ ...current, repository: "attacker/other" }))).rejects.toThrow(/identity/i);
  expect((await store.get("run-1"))?.repository).toBe("owner/private-app");
  expect(() => new FirestoreHostedRunStore({
    projectId: "../../attacker", collectionId: "accesswrightRuns",
    getAccessToken: () => Promise.resolve("token"),
  })).toThrow(/project/i);
});

it("allows the run submission and trusted finish workflow to survive service restart", async () => {
  const f = fixture();
  const report = {
    schemaVersion: 1,
    startedAt: "2026-10-09T12:00:00.000Z",
    finishedAt: "2026-10-09T12:01:00.000Z",
    durationMs: 60000,
    status: "verified",
    applied: false,
    fixed: 1, rejected: 0, needsHuman: 0, ignored: 0, attempts: 1,
    providerVerification: "not-run",
    unknownUsage: false,
    usage: { inputTokens: 0, outputTokens: 0, spentUsd: 0 },
    checks: (["build", "typecheck", "lint", "tests"] as const).map(check => ({
      check, available: true, status: "passed", durationMs: 1, exitCode: 0, failureIds: [],
    })),
    outcomes: [{
      id: "fix-1", ruleId: "button-name", criterion: "4.1.2", route: "llm",
      status: "verified", reason: null,
    }],
    final: { acceptedFixIds: ["fix-1"], droppedFixIds: [], failures: [] },
  };
  const dependencies = {
    authenticate: (id: string, token: string) => {
      if (id !== "run-1" || token !== "valid-token") throw new Error("Run authorization failed");
      return { runId: id, repository: "owner/private-app", installationId: 42 };
    },
    verifyTrustedResult: (_id: string, reportDigest: string) =>
      Promise.resolve({ reportDigest, verifiedBaseSha: "b".repeat(40) }),
  };
  const first = new HostedRunWorkflow({ ...dependencies, store: f.open() });
  expect((await first.submitResults("run-1", "valid-token", report)).status).toBe("recorded");
  const restarted = new HostedRunWorkflow({ ...dependencies, store: f.open() });
  expect(await restarted.finish("run-1", "valid-token")).toMatchObject({
    status: "ready-for-review", verifiedBaseSha: "b".repeat(40),
  });
  expect((await first.inspect("run-1", "valid-token"))?.status).toBe("ready-for-review");
});

it("claims independent verification once across service replicas and retains interrupted claims", async () => {
  const f = fixture();
  await f.open().insert(record);
  let checks = 0;
  let started: () => void = () => undefined;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let release: (receipt: TrustedRunReceipt) => void = () => undefined;
  const pending = new Promise<TrustedRunReceipt>(resolve => { release = resolve; });
  const proof = { reportDigest: record.reportDigest, verifiedBaseSha: "b".repeat(40) };
  const dependencies = {
    authenticate: (runId: string) => ({ runId, repository: record.repository, installationId: record.installationId }),
    verifyTrustedResult: () => { checks++; started(); return checks === 1 ? pending : Promise.resolve(proof); },
  };
  const first = new HostedRunWorkflow({ ...dependencies, store: f.open() }).finish(record.runId, "token");
  await entered;
  try {
    await expect(new HostedRunWorkflow({ ...dependencies, store: f.open() }).finish(record.runId, "token")).rejects.toThrow(/progress|conflict/i);
    expect(checks).toBe(1);
    expect((await f.open().get(record.runId))?.status).toBe("verifying");
  } finally { release(proof); await first; }
  expect((await new HostedRunWorkflow({ ...dependencies, store: f.open() }).finish(record.runId, "token")).status).toBe("ready-for-review");
  expect(checks).toBe(1);

  const interrupted = { ...record, runId: "interrupted" };
  await f.open().insert(interrupted);
  const fail = { ...dependencies, verifyTrustedResult: () => { checks++; return Promise.reject(new Error("Verifier disconnected")); } };
  await expect(new HostedRunWorkflow({ ...fail, store: f.open() }).finish(interrupted.runId, "token")).rejects.toThrow("Verifier disconnected");
  expect((await f.open().get(interrupted.runId))?.status).toBe("verifying");
  await expect(new HostedRunWorkflow({ ...fail, store: f.open() }).finish(interrupted.runId, "token")).rejects.toThrow(/progress/);
  expect(checks).toBe(2);
});

it("persists staging exclusion and interrupted private writes across independent service instances", async () => {
  const f = fixture(); const candidate = hostedCandidateFixture();
  let calls = 0, markEntered: () => void = () => undefined, releaseUpload: () => void = () => undefined;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  const release = new Promise<void>(resolve => { releaseUpload = resolve; });
  const dependencies = { authenticate: (runId: string) => ({ runId, repository: record.repository, installationId: record.installationId }),
    receiveCandidate: async () => { calls++; markEntered(); await release; },
    verifyTrustedResult: (_id: string, reportDigest: string) => Promise.resolve({ reportDigest, verifiedBaseSha: "b".repeat(40) }) };
  const uploading = new HostedRunWorkflow({ ...dependencies, store: f.open() }).submitCandidate("staging-run", "fixture", candidate);
  await entered;
  const restarted = new HostedRunWorkflow({ ...dependencies, store: f.open() });
  try {
    expect((await f.open().get("staging-run"))?.status).toBe("staging");
    await expect(restarted.finish("staging-run", "fixture")).rejects.toThrow(/staging/i);
    await expect(restarted.submitCandidate("staging-run", "fixture", candidate)).rejects.toThrow(/staging|conflict/i);
    expect(calls).toBe(1);
  } finally { releaseUpload(); await uploading; }
  expect(await restarted.finish("staging-run", "fixture")).toMatchObject({ status: "ready-for-review" });
  const interrupted = { ...dependencies, receiveCandidate: () => { calls++; return Promise.reject(new Error("write uncertain")); } };
  await expect(new HostedRunWorkflow({ ...interrupted, store: f.open() }).submitCandidate("interrupted-staging", "fixture", candidate)).rejects.toThrow("write uncertain");
  await expect(new HostedRunWorkflow({ ...interrupted, store: f.open() }).submitCandidate("interrupted-staging", "fixture", candidate)).rejects.toThrow(/staging/i);
  expect(calls).toBe(2);
});
