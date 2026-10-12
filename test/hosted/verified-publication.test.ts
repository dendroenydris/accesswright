import { expect, it, vi } from "vitest";
import type { GitHubRequest } from "../../src/reporter/github-publisher.js";
import { hostedVerifiedArtifactDigest, publishHostedVerifiedCandidate } from "../../src/hosted/verified-publication.js";
import { hostedCandidateFixture, hostedVerifiedCandidateFixture } from "../helpers/hosted-candidate.js";

function fixture() {
  const artifact = hostedVerifiedCandidateFixture(hostedCandidateFixture(), "f".repeat(40)).artifact;
  const options = { repository: "owner/repo", baseBranch: "main", actorLogin: "accesswright[bot]", title: "Verified accessibility repairs",
    candidateDigest: artifact.candidateDigest, workerReportDigest: artifact.workerReportDigest, verifiedBaseSha: artifact.verifiedBaseSha,
    artifactDigest: hostedVerifiedArtifactDigest(artifact) };
  const request = vi.fn<GitHubRequest>((method, path) => {
    if (path.endsWith("/git/ref/heads/main")) return Promise.resolve({ object: { sha: artifact.verifiedBaseSha } });
    if (path.includes("/git/ref/heads/")) return Promise.resolve(null);
    if (path.includes("/pulls?") && method === "GET") return Promise.resolve([]);
    if (path.includes("/git/commits/") && method === "GET") return Promise.resolve({ sha: artifact.verifiedBaseSha, tree: { sha: "a".repeat(40) } });
    if (path.includes("/git/trees/") && method === "GET") return Promise.resolve({ truncated: false, tree: [{ path: "Button.tsx", mode: "100644", type: "blob" }] });
    if (path.includes("/contents/")) return Promise.resolve({ type: "file", encoding: "base64", content: Buffer.from("private-source-marker").toString("base64") });
    if (path.endsWith("/git/trees") || path.endsWith("/git/commits")) return Promise.resolve({ sha: "b".repeat(40) });
    if (path.endsWith("/git/refs")) return Promise.resolve({});
    if (path.endsWith("/pulls")) return Promise.resolve({ number: 1, html_url: "https://github.com/owner/repo/pull/1" });
    return Promise.reject(new Error("Unexpected fake GitHub request"));
  });
  return { artifact, options, request };
}

it("publishes the bound trusted full source through the existing guarded publisher and rebuilt report", async () => {
  const f = fixture();
  expect(await publishHostedVerifiedCandidate(f.request, f.options, f.artifact)).toMatchObject({ status: "created", number: 1 });
  expect(f.request).toHaveBeenCalledWith("POST", "/repos/owner/repo/git/trees", expect.objectContaining({
    tree: [{ path: "Button.tsx", mode: "100644", type: "blob", content: "private-repaired-marker" }],
  }));
  const body = f.request.mock.calls.find(([method, path]) => method === "POST" && path.endsWith("/pulls"))?.[2]?.body;
  expect(body).toContain("1 verified fix groups"); expect(body).toContain("Human review"); expect(body).not.toContain("private-source-marker");
  expect(f.request.mock.calls.some(([, , body]) => body?.force === true)).toBe(false);
});

it.each(["candidateDigest", "workerReportDigest", "verifiedBaseSha", "artifactDigest"] as const)("rejects changed %s before any GitHub call", async field => {
  const f = fixture(); f.options[field] = "0".repeat(field === "verifiedBaseSha" ? 40 : 64);
  await expect(publishHostedVerifiedCandidate(f.request, f.options, f.artifact)).rejects.toThrow("identity mismatch");
  expect(f.request).not.toHaveBeenCalled();
});

it.each(["source", "report", "task", "check"])("rejects changed %s even if worker success flags remain true", async kind => {
  const f = fixture();
  if (kind === "source") f.artifact.patches[0].changes[0].after = "forged source";
  if (kind === "report") f.artifact.report.needsHuman = 123;
  if (kind === "task") f.artifact.patches[0].taskId = "unverified";
  if (kind === "check") f.artifact.report.checks[0].available = false;
  await expect(publishHostedVerifiedCandidate(f.request, f.options, f.artifact)).rejects.toThrow();
  expect(f.request).not.toHaveBeenCalled();
});

it.each(["receipt", "worker"])("rejects a pure %s payload as publication authority", async kind => {
  const f = fixture(), trusted = hostedVerifiedCandidateFixture(hostedCandidateFixture(), f.artifact.verifiedBaseSha);
  await expect(publishHostedVerifiedCandidate(f.request, f.options, kind === "receipt" ? trusted.receipt : hostedCandidateFixture())).rejects.toThrow();
  expect(f.request).not.toHaveBeenCalled();
});

it("keeps exact original source preflight before Git writes", async () => {
  const f = fixture();
  f.artifact.patches[0].changes[0].before = "different original source";
  f.options.artifactDigest = hostedVerifiedArtifactDigest(f.artifact);
  await expect(publishHostedVerifiedCandidate(f.request, f.options, f.artifact)).rejects.toThrow("Verified source changed");
  expect(f.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
});
