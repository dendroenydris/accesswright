import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createHostedCandidateCoordinator } from "../../src/hosted/candidate-coordinator.js";
import { FirestoreCandidateCleanupStore } from "../../src/hosted/candidate-cleanup.js";
import { hostedCandidateDigest } from "../../src/hosted/agent-protocol.js";
import type { HostedCandidate } from "../../src/hosted/agent-protocol.js";
import { hostedReportDigest } from "../../src/hosted/run-workflow.js";
import { verifyHostedCandidate } from "../../src/hosted/trusted-verifier.js";
import { hostedCandidateFixture, hostedVerifiedCandidateFixture } from "../helpers/hosted-candidate.js";
import { createFakeFirestore } from "../helpers/fake-firestore.js";
import { hostedVerifiedArtifactDigest } from "../../src/hosted/verified-publication.js";
import type { HostedVerifiedArtifact, HostedVerifiedCandidateConsumer } from "../../src/hosted/verified-publication.js";

vi.mock("../../src/hosted/trusted-verifier.js", () => ({ verifyHostedCandidate: vi.fn() }));
let root: string;
const candidate = hostedCandidateFixture(), digest = hostedReportDigest(candidate.report);
const reconciled = { usage: candidate.report.usage, unknownUsage: false, providerVerification: "not-run" as const };
const checkout = { repoPath: "/trusted/checkout", verifiedBaseSha: "f".repeat(40), tempRoot: "/trusted/tmp", runtimeRoot: "/trusted/runtime" };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aw-durable-candidate-"));
  vi.mocked(verifyHostedCandidate).mockResolvedValue(hostedVerifiedCandidateFixture(candidate, checkout.verifiedBaseSha));
});
afterEach(async () => { vi.clearAllMocks(); await rm(root, { recursive: true, force: true }); });
function fixture() {
  const rows = new Map<string, { candidate: HostedCandidate; generation: string; candidateDigest: string; expiresAt: string }>();
  const scheduleVerification = vi.fn(() => Promise.resolve());
  const store = {
    put: vi.fn((runId: string, input: HostedCandidate) => {
      expect(scheduleVerification).toHaveBeenCalledWith(runId, hostedReportDigest(input.report));
      const reference = { generation: "12345678901234567890", candidateDigest: hostedCandidateDigest(input), expiresAt: new Date(Date.now() + 900_000).toISOString() };
      rows.set(runId, { ...reference, candidate: structuredClone(input) }); return Promise.resolve(reference);
    }),
    get: vi.fn((runId: string) => Promise.resolve(structuredClone(rows.get(runId) ?? null))),
    remove: vi.fn((runId: string, generation: string) => {
      expect(generation).toBe(rows.get(runId)?.generation); rows.delete(runId); return Promise.resolve();
    }),
  };
  const release = vi.fn(() => Promise.resolve());
  const lease = { ...checkout, release };
  const sealForVerification = vi.fn(() => Promise.resolve(reconciled)), resolveCheckout = vi.fn(() => Promise.resolve(lease));
  const metadata = createFakeFirestore("candidateCleanup");
  const cleanup = new FirestoreCandidateCleanupStore(metadata.options);
  const open = (evidenceRoot = root, onVerifiedCandidate?: HostedVerifiedCandidateConsumer) => createHostedCandidateCoordinator({
    agent: { sealForVerification }, store, cleanup, evidenceRoot, resolveCheckout, scheduleVerification,
    ...(onVerifiedCandidate ? { onVerifiedCandidate } : {}),
  });
  return { rows, store, cleanup, sealForVerification, resolveCheckout, release, lease, scheduleVerification, open };
}

it("survives coordinator restart, seals service usage, independently replays, and confirms source deletion before its receipt", async () => {
  const f = fixture(); await f.open().receiveCandidate("run1", candidate);
  vi.mocked(verifyHostedCandidate).mockImplementationOnce(() => {
    expect(f.release).not.toHaveBeenCalled();
    return Promise.resolve(hostedVerifiedCandidateFixture(candidate, checkout.verifiedBaseSha));
  });
  expect(await f.open().verifyTrustedResult("run1", digest)).toEqual({ reportDigest: digest, verifiedBaseSha: checkout.verifiedBaseSha });
  expect(verifyHostedCandidate).toHaveBeenCalledExactlyOnceWith({ ...f.lease, reconciled }, candidate);
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.rows.size).toBe(0); expect(f.store.remove).toHaveBeenCalledExactlyOnceWith("run1", "12345678901234567890");
  expect(await f.cleanup.get("run1")).toMatchObject({ status: "cleared", candidateDigest: hostedCandidateDigest(candidate) });
  expect(await f.open().verifyTrustedResult("run1", digest)).toBeNull();
  const log = await readFile(join(root, "run1/run.jsonl"), "utf8");
  expect(log).toContain("hosted-candidate-staged"); expect(log).toContain("hosted-checkout-cleared"); expect(log).toContain("hosted-candidate-cleared");
  expect(log).not.toContain("private-source-marker"); expect(log).not.toContain("private-repaired-marker");
});

it("delivers a digest-bound private artifact only after checkout erasure and durable candidate deletion", async () => {
  const f = fixture(), trusted = hostedVerifiedCandidateFixture(candidate, checkout.verifiedBaseSha);
  const consume = vi.fn(async (runId: string, artifact: HostedVerifiedArtifact, artifactDigest: string) => {
    expect(runId).toBe("run1"); expect(artifact).toEqual(trusted.artifact); expect(artifactDigest).toBe(hostedVerifiedArtifactDigest(trusted.artifact));
    expect(f.release).toHaveBeenCalledOnce(); expect(f.rows.size).toBe(0);
    expect((await f.cleanup.get(runId))?.status).toBe("cleared");
  }) satisfies HostedVerifiedCandidateConsumer;
  await f.open().receiveCandidate("run1", candidate);
  expect(await f.open(root, consume).verifyTrustedResult("run1", digest)).toEqual(trusted.receipt);
  expect(consume).toHaveBeenCalledOnce();
  expect(await f.open(root, consume).verifyTrustedResult("run1", digest)).toBeNull();
  expect(consume).toHaveBeenCalledOnce();
  const log = await readFile(join(root, "run1/run.jsonl"), "utf8");
  expect(log).toContain("hosted-verified-artifact-delivered"); expect(log).not.toContain("private-source-marker");
});

it.each(["checkout", "deletion", "confirmation"])("never delivers private publication source on failed %s cleanup", async failure => {
  const f = fixture(), consume = vi.fn(() => Promise.resolve());
  await f.open().receiveCandidate("run1", candidate);
  if (failure === "checkout") f.release.mockRejectedValueOnce(new Error("cleanup unconfirmed"));
  if (failure === "deletion") f.store.remove.mockRejectedValueOnce(new Error("cleanup unconfirmed"));
  if (failure === "confirmation") vi.spyOn(f.cleanup, "confirm").mockRejectedValueOnce(new Error("cleanup unconfirmed"));
  await expect(f.open(root, consume).verifyTrustedResult("run1", digest)).rejects.toThrow("cleanup unconfirmed");
  expect(consume).not.toHaveBeenCalled();
});

it("rejects a replay artifact bound to another candidate and still clears owned source", async () => {
  const f = fixture(), consume = vi.fn(() => Promise.resolve()), wrong = hostedVerifiedCandidateFixture(candidate, checkout.verifiedBaseSha);
  wrong.artifact.candidateDigest = "0".repeat(64); vi.mocked(verifyHostedCandidate).mockResolvedValueOnce(wrong);
  await f.open().receiveCandidate("run1", candidate);
  await expect(f.open(root, consume).verifyTrustedResult("run1", digest)).rejects.toThrow("identity mismatch");
  expect(consume).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce(); expect(f.rows.size).toBe(0);
});

it("withholds the receipt on uncertain artifact delivery and never retries a consumed candidate", async () => {
  const f = fixture(), consume = vi.fn(() => Promise.reject(new Error("publication acknowledgment lost")));
  await f.open().receiveCandidate("run1", candidate);
  await expect(f.open(root, consume).verifyTrustedResult("run1", digest)).rejects.toThrow("publication acknowledgment lost");
  expect(await f.open(root, consume).verifyTrustedResult("run1", digest)).toBeNull(); expect(consume).toHaveBeenCalledOnce();
  expect(await readFile(join(root, "run1/run.jsonl"), "utf8")).toContain("hosted-verified-artifact-delivery-unconfirmed");
});

it("refuses private writes when metadata verification scheduling fails", async () => {
  const f = fixture(); f.scheduleVerification.mockRejectedValueOnce(new Error("queue unavailable"));
  await expect(f.open().receiveCandidate("run1", candidate)).rejects.toThrow("queue unavailable");
  expect(f.store.put).not.toHaveBeenCalled();
});

it("rejects inconsistent trusted usage before scheduling or retaining any source", async () => {
  const f = fixture(), forged = structuredClone(candidate); forged.report.usage.inputTokens = 1;
  await expect(f.open().receiveCandidate("run1", forged)).rejects.toThrow("trusted service settlements");
  expect(f.store.put).not.toHaveBeenCalled(); expect(f.scheduleVerification).not.toHaveBeenCalled();
});

it("discards ineligible candidates while scheduling their metadata-only blocked finish", async () => {
  const f = fixture(), invalid = structuredClone(candidate); invalid.report.checks[0].status = "failed";
  await f.open().receiveCandidate("run1", invalid);
  expect(f.store.put).not.toHaveBeenCalled(); expect(f.scheduleVerification).toHaveBeenCalledOnce();
  expect(await readFile(join(root, "run1/run.jsonl"), "utf8")).toContain("hosted-candidate-discarded");
});

it("clears a mismatched report without invoking the trusted verifier", async () => {
  const f = fixture(); await f.open().receiveCandidate("run1", candidate);
  expect(await f.open().verifyTrustedResult("run1", "0".repeat(64))).toBeNull();
  expect(verifyHostedCandidate).not.toHaveBeenCalled(); expect(f.rows.size).toBe(0);
});

it("erases private staging when replay fails and does not blindly repeat verification", async () => {
  const f = fixture(); await f.open().receiveCandidate("run1", candidate);
  vi.mocked(verifyHostedCandidate).mockRejectedValueOnce(new Error("verifier interrupted"));
  await expect(f.open().verifyTrustedResult("run1", digest)).rejects.toThrow("verifier interrupted");
  expect(f.rows.size).toBe(0); expect(await f.open().verifyTrustedResult("run1", digest)).toBeNull();
  expect(verifyHostedCandidate).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledOnce();
});

it("withholds a replay receipt if the fresh checkout cannot be erased, while clearing the staged candidate", async () => {
  const f = fixture(); await f.open().receiveCandidate("run1", candidate);
  f.release.mockRejectedValueOnce(new Error("checkout erasure unconfirmed"));
  await expect(f.open().verifyTrustedResult("run1", digest)).rejects.toThrow("checkout erasure unconfirmed");
  expect(f.rows.size).toBe(0); expect((await f.cleanup.get("run1"))?.status).toBe("cleared");
  expect(await f.open().verifyTrustedResult("run1", digest)).toBeNull();
  expect(verifyHostedCandidate).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
  expect(await readFile(join(root, "run1/run.jsonl"), "utf8")).not.toContain("hosted-checkout-cleared");
  expect(await readFile(join(root, "run1/run.jsonl"), "utf8")).toContain("hosted-checkout-cleanup-unconfirmed");
});

it("withholds successful replay when private deletion is unconfirmed", async () => {
  const f = fixture(); await f.open().receiveCandidate("run1", candidate);
  f.store.remove.mockRejectedValueOnce(new Error("cleanup unconfirmed"));
  await expect(f.open().verifyTrustedResult("run1", digest)).rejects.toThrow("cleanup unconfirmed");
  expect(f.rows.size).toBe(1);
  expect((await f.cleanup.get("run1"))?.status).toBe("pending");
  expect(await readFile(join(root, "run1/run.jsonl"), "utf8")).not.toContain("hosted-candidate-cleared");
});

it("erases uploaded source if staging metadata cannot be recorded", async () => {
  const f = fixture(), blocked = join(root, "not-a-directory"); await writeFile(blocked, "owned test marker");
  await expect(f.open(blocked).receiveCandidate("run1", candidate)).rejects.toThrow("staging evidence failed");
  expect(f.rows.size).toBe(0); expect(f.store.remove).toHaveBeenCalledOnce();
});

it("withholds a replay receipt when durable cleanup confirmation fails after physical erasure", async () => {
  const f = fixture(); await f.open().receiveCandidate("run1", candidate);
  vi.spyOn(f.cleanup, "confirm").mockRejectedValueOnce(new Error("confirmation lost"));
  await expect(f.open().verifyTrustedResult("run1", digest)).rejects.toThrow("confirmation lost");
  expect(f.rows.size).toBe(0); expect((await f.cleanup.get("run1"))?.status).toBe("pending");
  expect(await readFile(join(root, "run1/run.jsonl"), "utf8")).not.toContain("hosted-candidate-cleared");
});
