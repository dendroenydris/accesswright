import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import { defaults } from "../../src/config.js";
import { verifyHostedCandidate } from "../../src/hosted/trusted-verifier.js";
import { hostedReportDigest } from "../../src/hosted/run-workflow.js";
import { RunReportSchema } from "../../src/reporter/report.js";
import { listSnapshotFiles } from "../../src/runner/patch-journal.js";
import { createDetachedContainer, dockerControl } from "../../src/sandbox/docker-control.js";
import { dockerCopyToHost, dockerExec, dockerExecResult, stopDockerContainer } from "../../src/sandbox/docker.js";
import { removePlatformMetadata } from "../../src/sandbox/platform-metadata.js";
import { copyTargetSnapshot } from "../../src/sandbox/source-boundary.js";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";

it("runs a non-root worker through a fake HTTP model service and independently replays its patches in Docker", async () => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, "ephemeral-worker-fixture-"));
  const repoPath = join(root, "repo"), input = join(root, "input");
  const name = "accesswright-ephemeral-" + randomUUID().slice(0, 12);
  let created = false;
  try {
    await createNextIntegrationFixture(repoPath);
    const files = await listSnapshotFiles(repoPath);
    const git = async (args: string[]) => (await execa("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", ...args], {
      cwd: repoPath, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, extendEnv: false,
    })).stdout.trim();
    await git(["init"]); await git(["add", "--", ...files]); await git(["commit", "-m", "fixture"]);
    const baseSha = await git(["rev-parse", "HEAD"]);
    await copyTargetSnapshot(repoPath, input);
    await createDetachedContainer({ name, detach: true, image: defaults.dockerImage, noNewPrivileges: true, command: ["sleep", "infinity"], extraVolumes: [
      { hostPath: join(process.cwd(), "dist"), containerPath: "/accesswright/dist", readOnly: true },
      { hostPath: await realpath(join(process.cwd(), "node_modules")), containerPath: "/accesswright/node_modules", readOnly: true },
      { hostPath: join(process.cwd(), "package.json"), containerPath: "/accesswright/package.json", readOnly: true },
      { hostPath: input, containerPath: "/input", readOnly: true },
    ] });
    created = true;
    await dockerControl(["start", name]);
    await dockerExec(name, ["mkdir", "-p", "/workspace", "/tmp/accesswright"]);
    await dockerExec(name, ["chown", "-R", "pwuser:pwuser", "/workspace", "/tmp/accesswright"]);
    const job = await dockerExecResult(name, ["node", "/accesswright/dist/test/e2e/ephemeral-repair-entry.js"], {
      user: "pwuser", environment: { ACCESSWRIGHT_ISOLATED_WORKER: "1" }, timeoutMs: defaults.installTimeoutMs + defaults.productionCheckTimeoutMs,
    });
    expect(job.stderr, "Owned fixture worker diagnostic").toBe("");
    expect(job.exitCode).toBe(0);
    expect(JSON.parse(job.stdout)).toMatchObject({ privateSourceRemoved: true, paidCalls: 0, fakeProviderCalls: 1 });
    const transfer = join(root, "candidate.json");
    await dockerCopyToHost(name, "/tmp/owned-candidate.json", transfer);
    const candidate: unknown = JSON.parse(await readFile(transfer, "utf8"));
    const parsed = RunReportSchema.parse(typeof candidate === "object" && candidate !== null && "report" in candidate ? candidate.report : null);
    expect(parsed).toMatchObject({ fixed: 3, providerVerification: "fake-provider", usage: { inputTokens: 300, outputTokens: 100, spentUsd: 0.0005 } });
    await removePlatformMetadata(repoPath);
    const receipt = await verifyHostedCandidate({ repoPath, verifiedBaseSha: baseSha, tempRoot: join(root, "trusted-runs"), runtimeRoot: process.cwd(),
      reconciled: { usage: { inputTokens: 300, outputTokens: 100, spentUsd: 0.0005 }, unknownUsage: false, providerVerification: "fake-provider" } }, candidate);
    expect(receipt).toEqual({ reportDigest: hostedReportDigest(parsed), verifiedBaseSha: baseSha });
    expect(await git(["status", "--porcelain", "--untracked-files=all"])).toBe("");
    const evidence = await mkdtemp(join(tempRoot, "ephemeral-worker-evidence-"));
    await writeFile(join(evidence, "result.json"), JSON.stringify({ kind: "owned-secretless-worker-and-independent-docker-verifier", ...receipt,
      acceptedFixes: parsed.fixed, privateSourceRemoved: true, paidCalls: 0, fakeProviderCalls: 1 }), { flag: "wx", mode: 0o600 });
    console.log("Secretless worker and independent verifier evidence:", evidence);
  } finally {
    try { if (created) await stopDockerContainer(name); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
