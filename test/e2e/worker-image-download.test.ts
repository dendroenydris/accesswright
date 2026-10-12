import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import { defaults } from "../../src/config.js";
import { HostedCandidateSchema } from "../../src/hosted/agent-protocol.js";
import { createHostedInputBundle } from "../../src/hosted/input-bundle.js";
import { verifyHostedCandidate } from "../../src/hosted/trusted-verifier.js";
import { listSnapshotFiles } from "../../src/runner/patch-journal.js";
import { createDetachedContainer, dockerControl } from "../../src/sandbox/docker-control.js";
import { dockerCopy, dockerCopyToHost, dockerExecResult, stopDockerContainer } from "../../src/sandbox/docker.js";
import { removePlatformMetadata } from "../../src/sandbox/platform-metadata.js";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";

const image = process.env.ACCESSWRIGHT_TEST_WORKER_IMAGE;
// Opt-in acceptance of a separately built, immutable local image; no registry publishing.
it.skipIf(!image)("downloads pinned input in the generic non-root image, cleans it before transfer and passes independent Docker replay", async () => {
  if (!image || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("An immutable local worker image ID is required");
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration"); await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, "worker-image-download-")), repoPath = join(root, "repo");
  const name = "accesswright-download-worker-" + randomUUID().slice(0, 12); let created = false;
  try {
    await createNextIntegrationFixture(repoPath); await removePlatformMetadata(repoPath);
    const files = await listSnapshotFiles(repoPath);
    const git = async (args: string[]) => (await execa("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", ...args], {
      cwd: repoPath, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, extendEnv: false,
    })).stdout.trim();
    await git(["init"]); await git(["add", "--", ...files]); await git(["commit", "-m", "fixture"]);
    const baseSha = await git(["rev-parse", "HEAD"]), transfer = join(root, "input-bundle.json");
    await removePlatformMetadata(repoPath);
    await writeFile(transfer, JSON.stringify(await createHostedInputBundle({ runId: "worker-fixture", repoPath, verifiedBaseSha: baseSha })), { mode: 0o600, flag: "wx" });
    await createDetachedContainer({ name, detach: true, image, noNewPrivileges: true, command: ["sleep", "infinity"], extraVolumes: [
      { hostPath: await realpath(join(process.cwd(), "dist/test")), containerPath: "/accesswright/dist/test", readOnly: true },
    ] }); created = true; await dockerControl(["start", name]);
    await dockerCopy(transfer, name, "/tmp/owned-input-bundle.json");
    const ownership = await dockerExecResult(name, ["chown", "pwuser:pwuser", "/tmp/owned-input-bundle.json"], { user: "root" }); expect(ownership.exitCode).toBe(0);
    const job = await dockerExecResult(name, ["node", "/accesswright/dist/test/e2e/worker-download-entry.js"], { timeoutMs: defaults.installTimeoutMs + defaults.productionCheckTimeoutMs });
    expect(job.exitCode).toBe(0); expect(job.stderr).toBe("");
    expect(JSON.parse(job.stdout)).toMatchObject({ ownedDownloadedInputRemoved: true, inputDownloads: 1, paidCalls: 0, fakeProviderCalls: 1 });
    const candidateFile = join(root, "candidate.json"); await dockerCopyToHost(name, "/tmp/owned-candidate.json", candidateFile);
    const candidate = HostedCandidateSchema.parse(JSON.parse(await readFile(candidateFile, "utf8")) as unknown);
    await removePlatformMetadata(repoPath);
    const evidence = await mkdtemp(join(tempRoot, "worker-image-download-evidence-"));
    const verified = await verifyHostedCandidate({ repoPath, verifiedBaseSha: baseSha, tempRoot: join(root, "trusted-runs"), runtimeRoot: process.cwd(),
      reconciled: { usage: { inputTokens: 300, outputTokens: 100, spentUsd: 0.0005 }, unknownUsage: false, providerVerification: "fake-provider" } }, candidate);
    const receipt = verified?.receipt;
    expect(verified?.artifact.patches).toEqual(candidate.patches);
    expect(verified?.artifact.report.fixed).toBe(3);
    expect(receipt?.verifiedBaseSha).toBe(baseSha); expect(await git(["status", "--porcelain", "--untracked-files=all"])).toBe("");
    await writeFile(join(evidence, "result.json"), JSON.stringify({ kind: "owned-generic-image-downloaded-input-independent-docker", image, status: "ready-for-review", baseSha,
      reportDigest: receipt?.reportDigest, acceptedFixes: candidate.report.fixed, ownedDownloadedInputRemoved: true, inputDownloads: 1, cloudApis: "fake", paidCalls: 0, fakeProviderCalls: 1 }), { mode: 0o600, flag: "wx" });
    console.log("Owned generic image/download evidence:", evidence);
  } finally { try { if (created) await stopDockerContainer(name); } finally { await rm(root, { recursive: true, force: true }); } }
});
