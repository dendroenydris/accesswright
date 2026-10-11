import { expect, it } from "vitest";

import { FirestoreHostedRunStore } from "../../src/hosted/firestore-run-store.js";
import { HostedRunWorkflow } from "../../src/hosted/run-workflow.js";
import type { StoredRunResult } from "../../src/hosted/run-workflow.js";
import { createFakeFirestore } from "../helpers/fake-firestore.js";

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
