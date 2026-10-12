import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHostedTrustedServices } from "../../src/hosted/services.js";
import { FirestoreHostedAgentRunStore } from "../../src/hosted/agent-run-store.js";
import { FirestoreHostedRunStore } from "../../src/hosted/firestore-run-store.js";
import { FirestoreHostedCheckoutRegistry } from "../../src/hosted/checkout-registry.js";
import { FirestoreCandidateCleanupStore } from "../../src/hosted/candidate-cleanup.js";
import { prepareHostedCheckout } from "../../src/hosted/checkout.js";
import { createHostedInputBundle } from "../../src/hosted/input-bundle.js";
import { verifyHostedCandidate } from "../../src/hosted/trusted-verifier.js";
import { hostedCandidateDigest } from "../../src/hosted/agent-protocol.js";
import type { HostedCandidate } from "../../src/hosted/agent-protocol.js";
import { hostedReportDigest } from "../../src/hosted/run-workflow.js";
import { createFakeFirestore } from "../helpers/fake-firestore.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";
import { hostedCandidateFixture, hostedVerifiedCandidateFixture } from "../helpers/hosted-candidate.js";
import type { HostedVerifiedCandidateConsumer } from "../../src/hosted/verified-publication.js";

vi.mock("../../src/hosted/checkout.js", () => ({ prepareHostedCheckout: vi.fn() }));
vi.mock("../../src/hosted/input-bundle.js", () => ({ createHostedInputBundle: vi.fn() }));
vi.mock("../../src/hosted/trusted-verifier.js", () => ({ verifyHostedCandidate: vi.fn() }));
const servers: Server[] = [];
let root: string;
const run = { runId: "1".repeat(32), repository: "owner/repo", installationId: 42,
  event: "installation" as const, pullNumber: null, createdAt: "2026-10-11T01:00:00.000Z" };
const source = { runId: run.runId, repository: run.repository, installationId: run.installationId };
const baseSha = "f".repeat(40), candidate = hostedCandidateFixture(), digest = hostedReportDigest(candidate.report);
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "aw-trusted-services-")); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  vi.clearAllMocks(); await rm(root, { recursive: true, force: true });
});
async function listen(server: Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture port missing");
  return "http://127.0.0.1:" + address.port;
}
function fixture() {
  const authorization = createFakeFirestore("agentRuns"), reports = createFakeFirestore("reports"), pins = createFakeFirestore("pins"), erasure = createFakeFirestore("erasure");
  const rows = new Map<string, { candidate: HostedCandidate; generation: string; expiresAt: string; candidateDigest: string }>();
  const candidates = {
    put: vi.fn((runId: string, value: HostedCandidate) => {
      const reference = { generation: "1", expiresAt: new Date(Date.now() + 900_000).toISOString(), candidateDigest: hostedCandidateDigest(value) };
      rows.set(runId, { ...reference, candidate: structuredClone(value) }); return Promise.resolve(reference);
    }),
    get: (runId: string) => Promise.resolve(structuredClone(rows.get(runId) ?? null)),
    remove: vi.fn((runId: string) => { rows.delete(runId); return Promise.resolve(); }),
    generationForCleanup: (runId: string) => Promise.resolve(rows.get(runId)?.generation ?? null),
  };
  const pinOriginalRevision = vi.fn(() => Promise.resolve(baseSha));
  const getInstallationToken = vi.fn(() => Promise.resolve("fixture-source-token"));
  const release = vi.fn(() => Promise.resolve());
  vi.mocked(prepareHostedCheckout).mockImplementation(input => Promise.resolve({ repoPath: "/fixture/owned-source", verifiedBaseSha: input.verifiedBaseSha,
    tempRoot: root, runtimeRoot: "/fixture/runtime", release }));
  vi.mocked(createHostedInputBundle).mockImplementation(input => Promise.resolve({ runId: input.runId, baseSha: input.verifiedBaseSha,
    files: [{ path: "View.tsx", mode: "100644", blobSha: "a".repeat(40), data: Buffer.from("fixture source").toString("base64") }] }));
  vi.mocked(verifyHostedCandidate).mockImplementation(input => Promise.resolve(hostedVerifiedCandidateFixture(candidate, input.verifiedBaseSha)));
  const provider = new FakeLlmProvider([]), scheduleVerification = vi.fn(() => Promise.resolve());
  const open = (onVerifiedCandidate?: HostedVerifiedCandidateConsumer) => {
    const services = createHostedTrustedServices({ agent: { model: { provider: "openai", id: "fixture-only" },
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, maxInputTokens: 1200, maxOutputTokens: 256, maxCostUsdPerRun: 0.02,
      ledgerForRun: () => Promise.reject(new Error("No model calls in this fixture")), provider, providerVerification: "fake-provider",
      runStore: new FirestoreHostedAgentRunStore(authorization.options) },
      runs: new FirestoreHostedRunStore(reports.options), checkouts: new FirestoreHostedCheckoutRegistry(pins.options),
      cleanup: new FirestoreCandidateCleanupStore(erasure.options), candidates, sourceAccess: { getInstallationToken },
      pinOriginalRevision, scheduleVerification, authenticateTask: value => Promise.resolve(value === "Bearer fixture-task-oidc"),
      ...(onVerifiedCandidate ? { onVerifiedCandidate } : {}),
      evidenceRoot: root, tempRoot: root, runtimeRoot: "/fixture/runtime" });
    servers.push(services.agentServer, services.taskServer); return services;
  };
  return { open, authorization, reports, pins, erasure, rows, release, provider, getInstallationToken, pinOriginalRevision, scheduleVerification };
}
const post = (origin: string, path: string, token: string, body: object) => fetch(origin + path, {
  method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body),
});

it("keeps uncertain publication claims durable across restart without another callback or source replay", async () => {
  const f = fixture(), consume = vi.fn(() => Promise.reject(new Error("GitHub response lost")));
  const service = f.open(consume), token = await service.registerRunToken(run), origin = await listen(service.agentServer);
  const staged = await post(origin, "/runs/" + run.runId + "/candidate", token, candidate); expect(staged.status).toBe(202); await staged.arrayBuffer();
  const taskOrigin = await listen(service.taskServer), path = "/internal/candidates/verify", body = { runId: run.runId, reportDigest: digest };
  const first = await post(taskOrigin, path, "fixture-task-oidc", body); expect(first.status).toBe(503); await first.arrayBuffer();
  expect(consume).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce(); expect(f.rows.size).toBe(0);
  expect((await new FirestoreHostedRunStore(f.reports.options).get(run.runId))?.status).toBe("verifying");
  const restarted = await listen(f.open(consume).taskServer), repeat = await post(restarted, path, "fixture-task-oidc", body);
  expect(repeat.status).toBe(503); await repeat.arrayBuffer(); expect(consume).toHaveBeenCalledOnce(); expect(verifyHostedCandidate).toHaveBeenCalledOnce();
  const metadata = JSON.stringify([...f.reports.records.values()]); expect(metadata).not.toContain("private-source-marker");
});

it("pins before registering a run and never replaces its original revision or returns a second token", async () => {
  const f = fixture(), service = f.open();
  f.pinOriginalRevision.mockImplementationOnce(() => { expect(f.authorization.records.size).toBe(0); return Promise.resolve(baseSha); });
  expect(await service.registerRunToken(run)).toMatch(/^[a-f0-9]{64}$/);
  f.pinOriginalRevision.mockResolvedValueOnce("a".repeat(40));
  await expect(f.open().registerRunToken(run)).rejects.toThrow();
  expect((await new FirestoreHostedCheckoutRegistry(f.pins.options).resolve(source)).verifiedBaseSha).toBe(baseSha);
  expect(f.authorization.records.size).toBe(1); expect(f.getInstallationToken).not.toHaveBeenCalled();
});

it("does not authorize or fetch source when original revision registration fails", async () => {
  const f = fixture(); f.pinOriginalRevision.mockRejectedValueOnce(new Error("Original revision unavailable"));
  await expect(f.open().registerRunToken(run)).rejects.toThrow("Original revision unavailable");
  expect(f.authorization.records.size).toBe(0); expect(f.pins.records.size).toBe(0); expect(prepareHostedCheckout).not.toHaveBeenCalled();
});

it("downloads only the persistent original pin and releases it before response, with one claim across restarts", async () => {
  const f = fixture(), first = f.open(), token = await first.registerRunToken(run), origin = await listen(first.agentServer);
  const invalid = await post(origin, "/runs/" + run.runId + "/input", "0".repeat(64), {});
  expect(invalid.status).toBe(401); await invalid.arrayBuffer(); expect(f.getInstallationToken).not.toHaveBeenCalled();
  const result = await post(origin, "/runs/" + run.runId + "/input", token, {});
  expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ baseSha }); expect(f.release).toHaveBeenCalledOnce();
  expect(f.getInstallationToken).toHaveBeenCalledExactlyOnceWith(source);
  expect(prepareHostedCheckout).toHaveBeenCalledWith(expect.objectContaining({ ...source, verifiedBaseSha: baseSha, installationToken: "fixture-source-token" }));
  const restarted = await listen(f.open().agentServer), repeat = await post(restarted, "/runs/" + run.runId + "/input", token, {});
  expect(repeat.status).toBe(409); await repeat.arrayBuffer(); expect(prepareHostedCheckout).toHaveBeenCalledOnce();
  expect(await readFile(join(root, run.runId, "run.jsonl"), "utf8")).not.toContain("fixture-source-token");
});

it.each([false, true])("composes separate durable candidate/task ingress and retains failed checkout erasure (%s)", async erasureFails => {
  const f = fixture(), first = f.open(), token = await first.registerRunToken(run), origin = await listen(first.agentServer);
  const staged = await post(origin, "/runs/" + run.runId + "/candidate", token, candidate);
  expect(staged.status).toBe(202); await staged.arrayBuffer(); expect(f.scheduleVerification).toHaveBeenCalledWith(run.runId, digest);
  expect(verifyHostedCandidate).not.toHaveBeenCalled();
  const restarted = f.open(), taskOrigin = await listen(restarted.taskServer), taskPath = "/internal/candidates/verify";
  const worker = await post(taskOrigin, taskPath, token, { runId: run.runId, reportDigest: digest });
  expect(worker.status).toBe(401); await worker.arrayBuffer(); expect(prepareHostedCheckout).not.toHaveBeenCalled();
  if (erasureFails) f.release.mockRejectedValueOnce(new Error("Erasure unavailable"));
  const verified = await post(taskOrigin, taskPath, "fixture-task-oidc", { runId: run.runId, reportDigest: digest });
  expect(verified.status).toBe(erasureFails ? 503 : 200); await verified.arrayBuffer();
  expect((await new FirestoreHostedRunStore(f.reports.options).get(run.runId))?.status).toBe(erasureFails ? "verifying" : "ready-for-review");
  expect(f.release).toHaveBeenCalledOnce(); expect(f.rows.size).toBe(0);
  expect((await new FirestoreCandidateCleanupStore(f.erasure.options).get(run.runId))?.status).toBe("cleared");
  const repeat = await post(taskOrigin, taskPath, "fixture-task-oidc", { runId: run.runId, reportDigest: digest });
  expect(repeat.status).toBe(erasureFails ? 503 : 200); await repeat.arrayBuffer(); expect(verifyHostedCandidate).toHaveBeenCalledOnce();
  expect(f.provider.requests).toHaveLength(0);
});
