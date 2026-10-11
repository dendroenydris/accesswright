import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHostedCandidateTaskServer } from "../../src/hosted/candidate-task-http.js";
import { createHostedCandidateCoordinator } from "../../src/hosted/candidate-coordinator.js";
import { FirestoreCandidateCleanupStore } from "../../src/hosted/candidate-cleanup.js";
import { FirestoreHostedRunStore } from "../../src/hosted/firestore-run-store.js";
import { HostedRunWorkflow, hostedReportDigest } from "../../src/hosted/run-workflow.js";
import { hostedCandidateDigest } from "../../src/hosted/agent-protocol.js";
import type { HostedCandidate } from "../../src/hosted/agent-protocol.js";
import { verifyHostedCandidate } from "../../src/hosted/trusted-verifier.js";
import { defaults } from "../../src/config.js";
import { createFakeFirestore } from "../helpers/fake-firestore.js";
import { hostedCandidateFixture } from "../helpers/hosted-candidate.js";

vi.mock("../../src/hosted/trusted-verifier.js", () => ({ verifyHostedCandidate: vi.fn() }));
const candidate = hostedCandidateFixture(), digest = hostedReportDigest(candidate.report), generation = "12345678901234567890";
const resources: Array<{ server: Server; root: string }> = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  for (const resource of resources.splice(0)) {
    await new Promise<void>(resolve => resource.server.close(() => resolve()));
    await rm(resource.root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aw-candidate-tasks-"));
  const expiry = new Date(Date.now() + 30_000).toISOString(); let workerExpired = false;
  const rows = new Map<string, { candidate: HostedCandidate; generation: string; candidateDigest: string; expiresAt: string }>();
  const metadata = createFakeFirestore("candidateCleanup"), runMetadata = createFakeFirestore("runs");
  const cleanup = new FirestoreCandidateCleanupStore(metadata.options), runs = new FirestoreHostedRunStore(runMetadata.options);
  const store = {
    put: vi.fn((runId: string, input: HostedCandidate) => {
      const ref = { generation, candidateDigest: hostedCandidateDigest(input), expiresAt: expiry };
      rows.set(runId, { ...ref, candidate: structuredClone(input) }); return Promise.resolve(ref);
    }),
    get: vi.fn((runId: string) => Promise.resolve(structuredClone(rows.get(runId) ?? null))),
    generationForCleanup: vi.fn((runId: string) => Promise.resolve(rows.get(runId)?.generation ?? null)),
    remove: vi.fn((runId: string, selected: string) => {
      expect(selected).toBe(generation); rows.delete(runId); return Promise.resolve();
    }),
  };
  const authenticate = (runId: string, token: string) => {
    if (workerExpired || token !== "worker-token") throw new Error("Worker authorization expired");
    return { runId, repository: "owned/private", installationId: 42 };
  };
  const coordinator = createHostedCandidateCoordinator({ store, cleanup, evidenceRoot: root,
    agent: { sealForVerification: () => Promise.resolve({ usage: candidate.report.usage, unknownUsage: false, providerVerification: "not-run" }) },
    scheduleVerification: () => Promise.resolve(),
    resolveCheckout: () => Promise.resolve({ repoPath: "/trusted/repo", verifiedBaseSha: "f".repeat(40), tempRoot: root, runtimeRoot: "/trusted/runtime" }) });
  const workflow = new HostedRunWorkflow({ store: runs, authenticate, ...coordinator });
  vi.mocked(verifyHostedCandidate).mockResolvedValue({ reportDigest: digest, verifiedBaseSha: "f".repeat(40) });
  const authenticateTask = vi.fn((authorization: string) => Promise.resolve(authorization === "Bearer fixture-google-task"));
  const server = createHostedCandidateTaskServer({ workflow, runs: new FirestoreHostedRunStore(runMetadata.options), store, cleanup, authenticateTask, evidenceRoot: root });
  resources.push({ server, root }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test listener");
  const origin = "http://127.0.0.1:" + address.port;
  const post = (kind: string, body: unknown, authorization = "Bearer fixture-google-task") => fetch(origin + "/internal/candidates/" + kind, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { root, rows, cleanup, runs, store, coordinator, workflow, authenticate, authenticateTask, expiry, post, expireWorker: () => { workerExpired = true; } };
}

it("requires separate task identity before parsing, rejects private payloads and bounds metadata bodies", async () => {
  const f = await fixture();
  const denied = await f.post("verify", "private-source-marker", "Bearer worker-token");
  expect(denied.status).toBe(401); expect(await denied.text()).not.toContain("private-source-marker");
  expect(verifyHostedCandidate).not.toHaveBeenCalled();
  const invalid = await f.post("verify", { runId: "run1", reportDigest: digest, patches: "private-source-marker" });
  expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain("private-source-marker");
  const oversized = await f.post("verify", "x".repeat(defaults.firestoreRecordMaxBytes + 1));
  expect(oversized.status).toBe(413); await oversized.arrayBuffer();
  expect(f.rows.size).toBe(0); expect(await f.runs.get("run1")).toBeUndefined();
});

it("finishes the exact persisted report after worker-token expiry, without repeating independent verification", async () => {
  const f = await fixture(); await f.workflow.submitCandidate("run1", "worker-token", candidate); f.expireWorker();
  await expect(f.workflow.finish("run1", "worker-token")).rejects.toThrow("expired");
  const wrong = await f.post("verify", { runId: "run1", reportDigest: "0".repeat(64) });
  expect(wrong.status).toBe(503); await wrong.arrayBuffer(); expect(verifyHostedCandidate).not.toHaveBeenCalled();
  const response = await f.post("verify", { runId: "run1", reportDigest: digest });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: "ready-for-review" });
  expect((await f.cleanup.get("run1"))?.status).toBe("cleared"); expect(f.rows.size).toBe(0);
  const repeated = await f.post("verify", { runId: "run1", reportDigest: digest });
  expect(repeated.status).toBe(200); await repeated.arrayBuffer(); expect(verifyHostedCandidate).toHaveBeenCalledOnce();
  const log = await readFile(join(f.root, "run1/run.jsonl"), "utf8");
  expect(log).toContain("hosted-candidate-verification-response"); expect(log).not.toMatch(/private-source-marker|fixture-google-task|worker-token/);
});

it("retains failed verification claims across task redelivery instead of rerunning paid or Docker work", async () => {
  const f = await fixture(); await f.workflow.submitCandidate("run1", "worker-token", candidate);
  f.store.remove.mockRejectedValueOnce(new Error("private-source-marker cleanup unconfirmed"));
  const response = await f.post("verify", { runId: "run1", reportDigest: digest });
  expect(response.status).toBe(503); expect(await response.text()).not.toContain("private-source-marker");
  expect((await f.runs.get("run1"))?.status).toBe("verifying"); expect((await f.cleanup.get("run1"))?.status).toBe("pending");
  const repeated = await f.post("verify", { runId: "run1", reportDigest: digest });
  expect(repeated.status).toBe(503); await repeated.arrayBuffer(); expect(verifyHostedCandidate).toHaveBeenCalledOnce();
});

it("never expires early or changes the original deadline, then confirms deletion and blocks the absent candidate", async () => {
  const f = await fixture(); await f.workflow.submitCandidate("run1", "worker-token", candidate);
  const early = await f.post("expire", { runId: "run1", expiresAt: f.expiry }); expect(early.status).toBe(503); await early.arrayBuffer();
  expect(f.store.remove).not.toHaveBeenCalled();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(f.expiry) + 1000);
  const changed = await f.post("expire", { runId: "run1", expiresAt: new Date(Date.parse(f.expiry) - 1000).toISOString() });
  expect(changed.status).toBe(503); await changed.arrayBuffer(); expect(f.store.remove).not.toHaveBeenCalled();
  const expired = await f.post("expire", { runId: "run1", expiresAt: f.expiry });
  expect(expired.status).toBe(200); await expired.arrayBuffer(); expect(f.rows.size).toBe(0);
  expect((await f.cleanup.get("run1"))?.status).toBe("cleared"); expect((await f.runs.get("run1"))?.status).toBe("blocked");
  const repeated = await f.post("expire", { runId: "run1", expiresAt: f.expiry });
  expect(repeated.status).toBe(200); await repeated.arrayBuffer(); expect(f.store.remove).toHaveBeenCalledOnce(); expect(verifyHostedCandidate).not.toHaveBeenCalled();
});

it("recovers the deletion generation after an interrupted upload without parsing corrupted source or releasing staging", async () => {
  const f = await fixture();
  const interrupted = new HostedRunWorkflow({ store: f.runs, authenticate: f.authenticate, verifyTrustedResult: f.coordinator.verifyTrustedResult,
    receiveCandidate: async (id, input) => { await f.store.put(id, input); throw new Error("process interrupted before receipt registration"); } });
  await expect(interrupted.submitCandidate("run1", "worker-token", candidate)).rejects.toThrow("interrupted");
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(f.expiry) + 1000);
  const expired = await f.post("expire", { runId: "run1", expiresAt: f.expiry });
  expect(expired.status).toBe(200); await expired.arrayBuffer();
  expect(f.store.generationForCleanup).toHaveBeenCalledExactlyOnceWith("run1"); expect(f.store.get).not.toHaveBeenCalled();
  expect(f.rows.size).toBe(0); expect((await f.cleanup.get("run1"))?.status).toBe("cleared");
  expect((await f.runs.get("run1"))?.status).toBe("staging"); expect(verifyHostedCandidate).not.toHaveBeenCalled();
});

it("recovers uncertain cleanup confirmation using the stored generation while missing unknown uploads remain pending", async () => {
  const f = await fixture(); await f.workflow.submitCandidate("run1", "worker-token", candidate);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(f.expiry) + 1000);
  vi.spyOn(f.cleanup, "confirm").mockRejectedValueOnce(new Error("confirmation lost"));
  const failed = await f.post("expire", { runId: "run1", expiresAt: f.expiry }); expect(failed.status).toBe(503); await failed.arrayBuffer();
  expect(f.rows.size).toBe(0); expect((await f.cleanup.get("run1"))?.status).toBe("pending");
  const retry = await f.post("expire", { runId: "run1", expiresAt: f.expiry }); expect(retry.status).toBe(200); await retry.arrayBuffer();
  expect(f.store.remove).toHaveBeenCalledTimes(2); expect(verifyHostedCandidate).not.toHaveBeenCalled();
  const interrupted = new HostedRunWorkflow({ store: f.runs, authenticate: f.authenticate, verifyTrustedResult: f.coordinator.verifyTrustedResult,
    receiveCandidate: () => Promise.reject(new Error("upload unconfirmed")) });
  await expect(interrupted.submitCandidate("unknown", "worker-token", candidate)).rejects.toThrow("unconfirmed");
  const absent = await f.post("expire", { runId: "unknown", expiresAt: f.expiry }); expect(absent.status).toBe(503); await absent.arrayBuffer();
  expect((await f.runs.get("unknown"))?.status).toBe("staging"); expect(await f.cleanup.get("unknown")).toBeUndefined();
});
