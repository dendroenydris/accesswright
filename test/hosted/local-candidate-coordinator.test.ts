import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaults } from "../../src/config.js";
import { createLocalHostedCandidateCoordinator } from "../../src/hosted/local-candidate-coordinator.js";
import { hostedReportDigest } from "../../src/hosted/run-workflow.js";
import { verifyHostedCandidate } from "../../src/hosted/trusted-verifier.js";
import { hostedCandidateFixture, hostedVerifiedCandidateFixture } from "../helpers/hosted-candidate.js";
import type { HostedVerifiedCandidateConsumer } from "../../src/hosted/verified-publication.js";

vi.mock("../../src/hosted/trusted-verifier.js", () => ({ verifyHostedCandidate: vi.fn() }));
let root: string;
const candidate = hostedCandidateFixture();
const reconciled = { usage: candidate.report.usage, unknownUsage: false, providerVerification: "not-run" as const };
const release = vi.fn(() => Promise.resolve());
const checkout = { repoPath: "/trusted/checkout", verifiedBaseSha: "f".repeat(40), tempRoot: "/trusted/tmp", runtimeRoot: "/trusted/runtime", release };
const sealForVerification = vi.fn(() => Promise.resolve(reconciled));
const resolveCheckout = vi.fn(() => Promise.resolve(checkout));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aw-candidate-coordinator-"));
  vi.mocked(verifyHostedCandidate).mockResolvedValue(hostedVerifiedCandidateFixture(candidate, checkout.verifiedBaseSha));
});
afterEach(async () => { vi.useRealTimers(); vi.clearAllMocks(); await rm(root, { recursive: true, force: true }); });
function coordinator(ttlSeconds = 30, onVerifiedCandidate?: HostedVerifiedCandidateConsumer) { return createLocalHostedCandidateCoordinator({
  agent: { sealForVerification }, evidenceRoot: root, resolveCheckout, ttlSeconds, ...(onVerifiedCandidate ? { onVerifiedCandidate } : {}),
}); }

it("seals trusted usage, independently verifies a pinned checkout and clears the private candidate", async () => {
  const service = coordinator();
  vi.mocked(verifyHostedCandidate).mockImplementationOnce(() => {
    expect(release).not.toHaveBeenCalled();
    return Promise.resolve(hostedVerifiedCandidateFixture(candidate, checkout.verifiedBaseSha));
  });
  await service.receiveCandidate("run1", candidate);
  const digest = hostedReportDigest(candidate.report);
  expect(await service.verifyTrustedResult("run1", digest)).toEqual({ reportDigest: digest, verifiedBaseSha: checkout.verifiedBaseSha });
  expect(verifyHostedCandidate).toHaveBeenCalledExactlyOnceWith({ ...checkout, reconciled }, candidate);
  expect(await service.verifyTrustedResult("run1", digest)).toBeNull();
  expect(resolveCheckout).toHaveBeenCalledExactlyOnceWith("run1");
  expect(release).toHaveBeenCalledOnce();
  const log = await readFile(join(root, "run1/run.jsonl"), "utf8");
  expect(log).toContain("hosted-candidate-staged"); expect(log).toContain("hosted-candidate-cleared");
  expect(log).not.toContain("private-source-marker"); expect(log).not.toContain("private-repaired-marker");
});
it("accepts simultaneous identical staging and rejects changed patch bytes", async () => {
  const service = coordinator();
  await Promise.all([service.receiveCandidate("run1", candidate), service.receiveCandidate("run1", candidate)]);
  const changed = structuredClone(candidate); changed.patches[0].changes[0].after = "changed";
  await expect(service.receiveCandidate("run1", changed)).rejects.toThrow("Conflicting candidate");
  await service.verifyTrustedResult("run1", hostedReportDigest(candidate.report));
  expect(verifyHostedCandidate).toHaveBeenCalledExactlyOnceWith({ ...checkout, reconciled }, candidate);
});
it("delivers only after checkout cleanup, consumes source once and returns metadata only", async () => {
  const consume = vi.fn(async (runId: string) => {
    expect(release).toHaveBeenCalledOnce();
    expect(await service.verifyTrustedResult(runId, hostedReportDigest(candidate.report))).toBeNull();
    expect(await readFile(join(root, runId, "run.jsonl"), "utf8")).toContain("hosted-candidate-cleared");
  });
  const service = coordinator(30, consume); await service.receiveCandidate("run1", candidate);
  expect(await service.verifyTrustedResult("run1", hostedReportDigest(candidate.report))).toEqual({
    reportDigest: hostedReportDigest(candidate.report), verifiedBaseSha: checkout.verifiedBaseSha,
  });
  expect(consume).toHaveBeenCalledOnce();
});
it("never delivers publication source when checkout erasure fails", async () => {
  const consume = vi.fn(() => Promise.resolve()), service = coordinator(30, consume);
  await service.receiveCandidate("run1", candidate); release.mockRejectedValueOnce(new Error("erasure failed"));
  await expect(service.verifyTrustedResult("run1", hostedReportDigest(candidate.report))).rejects.toThrow("erasure failed");
  expect(consume).not.toHaveBeenCalled();
});
it("discards reports ineligible for review without retaining private patches", async () => {
  const service = coordinator(); const invalid = structuredClone(candidate); invalid.report.checks[0].status = "failed";
  await service.receiveCandidate("run1", invalid);
  expect(await service.verifyTrustedResult("run1", hostedReportDigest(invalid.report))).toBeNull();
  expect(verifyHostedCandidate).not.toHaveBeenCalled();
  expect(await readFile(join(root, "run1/run.jsonl"), "utf8")).toContain("hosted-candidate-discarded");
});
it("rejects worker usage inconsistent with the trusted service before staging", async () => {
  const service = coordinator(); const changed = structuredClone(candidate); changed.report.usage.inputTokens = 1;
  await expect(service.receiveCandidate("run1", changed)).rejects.toThrow("trusted service settlements");
  expect(await service.verifyTrustedResult("run1", hostedReportDigest(changed.report))).toBeNull();
});
it("clears mismatched report identity and failed verification without retrying", async () => {
  const service = coordinator(); await service.receiveCandidate("run1", candidate);
  expect(await service.verifyTrustedResult("run1", "0".repeat(64))).toBeNull();
  expect(verifyHostedCandidate).not.toHaveBeenCalled();
  await service.receiveCandidate("run2", candidate);
  vi.mocked(verifyHostedCandidate).mockRejectedValueOnce(new Error("verifier failed"));
  await expect(service.verifyTrustedResult("run2", hostedReportDigest(candidate.report))).rejects.toThrow("verifier failed");
  expect(release).toHaveBeenCalledOnce();
  expect(await service.verifyTrustedResult("run2", hostedReportDigest(candidate.report))).toBeNull();
});
it("withholds a receipt on checkout cleanup failure and never replays the consumed candidate", async () => {
  const service = coordinator(); await service.receiveCandidate("run1", candidate);
  release.mockRejectedValueOnce(new Error("checkout erasure unconfirmed"));
  await expect(service.verifyTrustedResult("run1", hostedReportDigest(candidate.report))).rejects.toThrow("checkout erasure unconfirmed");
  expect(await service.verifyTrustedResult("run1", hostedReportDigest(candidate.report))).toBeNull();
  expect(release).toHaveBeenCalledOnce(); expect(verifyHostedCandidate).toHaveBeenCalledOnce();
  expect(await readFile(join(root, "run1/run.jsonl"), "utf8")).not.toContain("hosted-checkout-cleared");
  expect(await readFile(join(root, "run1/run.jsonl"), "utf8")).toContain("hosted-checkout-cleanup-unconfirmed");
});
it("expires private candidates and bounds the number of pending runs", async () => {
  vi.useFakeTimers(); const service = coordinator();
  for (let index = 0; index < defaults.hostedMaxStagedCandidates; index++) await service.receiveCandidate("run" + index, candidate);
  await expect(service.receiveCandidate("overflow", candidate)).rejects.toThrow("staging limit");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await service.verifyTrustedResult("run0", hostedReportDigest(candidate.report))).toBeNull();
  await service.receiveCandidate("after-expiry", candidate);
  await service.verifyTrustedResult("after-expiry", hostedReportDigest(candidate.report));
});
