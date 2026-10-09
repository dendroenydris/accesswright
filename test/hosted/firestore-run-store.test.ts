import { expect, it } from "vitest";

import { FirestoreHostedRunStore } from "../../src/hosted/firestore-run-store.js";
import type { StoredRunResult } from "../../src/hosted/run-workflow.js";

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
  const records = new Map<string, { payload: string; rev: number }>();
  const calls: Array<{ method: string; path: string; precondition: string | null }> = [];
  const fetcher: typeof fetch = (input, init) => {
    const uri = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    expect(uri.origin).toBe("https://firestore.googleapis.com");
    expect(headers.get("authorization")).toBe("Bearer local-fixture-identity");
    const name = uri.pathname.split("/").at(-1) ?? "";
    const key = method === "POST" ? (uri.searchParams.get("documentId") ?? "") : decodeURIComponent(name);
    const current = records.get(key);
    calls.push({ method, path: uri.pathname, precondition: uri.searchParams.get("currentDocument.updateTime") });
    const doc = (data: { payload: string; rev: number }) => ({
      name: uri.pathname,
      updateTime: "2026-10-09T12:00:" + String(data.rev).padStart(2, "0") + ".000Z",
      fields: { payload: { stringValue: data.payload } },
    });
    if (method === "GET") {
      return Promise.resolve(current ? Response.json(doc(current)) : new Response(null, { status: 404 }));
    }
    if (method === "POST") {
      if (current) return Promise.resolve(new Response("private-source-leak", { status: 409 }));
      const inputRecord = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { fields: { payload: { stringValue: string } } };
      const next = { payload: inputRecord.fields.payload.stringValue, rev: 1 };
      records.set(key, next);
      return Promise.resolve(Response.json(doc(next)));
    }
    if (method === "PATCH") {
      if (!current) return Promise.resolve(new Response(null, { status: 404 }));
      if (uri.searchParams.get("currentDocument.updateTime") !== doc(current).updateTime) {
        return Promise.resolve(new Response("private-source-leak", { status: 412 }));
      }
      const inputRecord = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { fields: { payload: { stringValue: string } } };
      const next = { payload: inputRecord.fields.payload.stringValue, rev: current.rev + 1 };
      records.set(key, next);
      return Promise.resolve(Response.json(doc(next)));
    }
    return Promise.resolve(new Response(null, { status: 405 }));
  };
  const open = () => new FirestoreHostedRunStore({
    projectId: "accesswright-dev-123",
    collectionId: "accesswrightRuns",
    getAccessToken: () => Promise.resolve("local-fixture-identity"),
    fetcher,
  });
  return { open, calls, records };
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
  const { HostedRunWorkflow } = await import("../../src/hosted/run-workflow.js");
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
