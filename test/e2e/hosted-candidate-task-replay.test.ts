import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import { defaults } from "../../src/config.js";
import { HostedCandidateSchema } from "../../src/hosted/agent-protocol.js";
import { createHostedCandidateCoordinator } from "../../src/hosted/candidate-coordinator.js";
import { FirestoreCandidateCleanupStore } from "../../src/hosted/candidate-cleanup.js";
import { createHostedCandidateTaskServer } from "../../src/hosted/candidate-task-http.js";
import { FirestoreHostedRunStore } from "../../src/hosted/firestore-run-store.js";
import { GcsHostedCandidateStore } from "../../src/hosted/gcs-candidate-store.js";
import { HostedRunWorkflow } from "../../src/hosted/run-workflow.js";
import { listSnapshotFiles } from "../../src/runner/patch-journal.js";
import { createDetachedContainer, dockerControl } from "../../src/sandbox/docker-control.js";
import { dockerCopyToHost, dockerExec, dockerExecResult, stopDockerContainer } from "../../src/sandbox/docker.js";
import { removePlatformMetadata } from "../../src/sandbox/platform-metadata.js";
import { copyTargetSnapshot } from "../../src/sandbox/source-boundary.js";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";
import { createFakeFirestore } from "../helpers/fake-firestore.js";

it("replays a real secretless worker candidate through durable fake-cloud adapters and trusted HTTP tasks", async () => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, "hosted-task-replay-fixture-")), repoPath = join(root, "repo"), input = join(root, "input");
  const name = "accesswright-task-worker-" + randomUUID().slice(0, 12); let created = false, service: Server | undefined;
  const objects = new Map<string, { generation: string; body: string }>();
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
    created = true; await dockerControl(["start", name]);
    await dockerExec(name, ["mkdir", "-p", "/workspace", "/tmp/accesswright"]);
    await dockerExec(name, ["chown", "-R", "pwuser:pwuser", "/workspace", "/tmp/accesswright"]);
    const job = await dockerExecResult(name, ["node", "/accesswright/dist/test/e2e/ephemeral-repair-entry.js"], {
      user: "pwuser", environment: { ACCESSWRIGHT_ISOLATED_WORKER: "1" }, timeoutMs: defaults.installTimeoutMs + defaults.productionCheckTimeoutMs });
    expect(job.stderr).toBe(""); expect(job.exitCode).toBe(0);
    expect(JSON.parse(job.stdout)).toMatchObject({ privateSourceRemoved: true, paidCalls: 0, fakeProviderCalls: 1 });
    const transfer = join(root, "candidate.json"); await dockerCopyToHost(name, "/tmp/owned-candidate.json", transfer);
    const candidate = HostedCandidateSchema.parse(JSON.parse(await readFile(transfer, "utf8")) as unknown);
    expect(candidate.report).toMatchObject({ fixed: 3, providerVerification: "fake-provider", usage: { inputTokens: 300, outputTokens: 100, spentUsd: 0.0005 } });
    await removePlatformMetadata(repoPath);
    const replayRepo = join(root, "replay-repo");
    await cp(repoPath, replayRepo, { recursive: true }); await removePlatformMetadata(replayRepo);
    const evidence = await mkdtemp(join(tempRoot, "hosted-task-replay-evidence-"));
    const cleanupMetadata = createFakeFirestore("cleanup"), runMetadata = createFakeFirestore("runs");
    const cleanup = new FirestoreCandidateCleanupStore(cleanupMetadata.options), runs = new FirestoreHostedRunStore(runMetadata.options);
    const expiries: Array<{ runId: string; expiresAt: string }> = [], verification: Array<{ runId: string; reportDigest: string }> = [];
    const bucket = "owned-replay-fixture";
    const fetcher: typeof fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      expect(url.origin).toBe("https://storage.googleapis.com");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-only-workload");
      if (url.pathname === "/storage/v1/b/" + bucket) return Promise.resolve(Response.json({ name: bucket,
        softDeletePolicy: { retentionDurationSeconds: "0" }, iamConfiguration: { publicAccessPrevention: "enforced", uniformBucketLevelAccess: { enabled: true } } }));
      const key = url.pathname.startsWith("/upload/") ? url.searchParams.get("name") ?? "" : decodeURIComponent(url.pathname.split("/o/")[1] ?? "");
      if (init?.method === "POST") {
        expect(url.searchParams.get("ifGenerationMatch")).toBe("0"); expect(expiries).toHaveLength(1);
        if (objects.has(key)) return Promise.resolve(new Response(null, { status: 412 }));
        if (typeof init.body !== "string") throw new Error("Missing owned candidate body");
        objects.set(key, { generation: "12345678901234567890", body: init.body });
      }
      const row = objects.get(key);
      if (!row || url.searchParams.get("softDeleted") === "true") return Promise.resolve(new Response(null, { status: 404 }));
      if (url.searchParams.has("generation")) expect(url.searchParams.get("generation")).toBe(row.generation);
      if (init?.method === "DELETE") {
        expect(url.searchParams.get("ifGenerationMatch")).toBe(row.generation); objects.delete(key);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.searchParams.get("alt") === "media") return Promise.resolve(new Response(row.body));
      return Promise.resolve(Response.json({ bucket, name: key, generation: row.generation, size: String(Buffer.byteLength(row.body)) }));
    };
    const store = new GcsHostedCandidateStore({ bucketName: bucket, fetcher, getAccessToken: () => Promise.resolve("fixture-only-workload"),
      scheduleExpiry: (runId, expiresAt) => { expiries.push({ runId, expiresAt }); return Promise.resolve(); } });
    const coordinator = createHostedCandidateCoordinator({ store, cleanup, evidenceRoot: evidence,
      agent: { sealForVerification: () => Promise.resolve({ usage: { inputTokens: 300, outputTokens: 100, spentUsd: 0.0005 }, unknownUsage: false, providerVerification: "fake-provider" }) },
      resolveCheckout: () => Promise.resolve({ repoPath: replayRepo, verifiedBaseSha: baseSha, tempRoot: join(root, "trusted-runs"), runtimeRoot: process.cwd(),
        release: () => rm(replayRepo, { recursive: true, force: true }) }),
      scheduleVerification: (runId, reportDigest) => { verification.push({ runId, reportDigest }); return Promise.resolve(); } });
    const workflow = new HostedRunWorkflow({ store: runs, ...coordinator,
      authenticate: runId => ({ runId, repository: "owned/fixture", installationId: 42 }) });
    await workflow.submitCandidate("worker-fixture", "fixture-token", candidate);
    expect((await new FirestoreHostedRunStore(runMetadata.options).get("worker-fixture"))?.status).toBe("recorded");
    expect(verification).toHaveLength(1); expect(expiries).toHaveLength(1); expect(objects.size).toBe(1);
    service = createHostedCandidateTaskServer({ workflow, runs: new FirestoreHostedRunStore(runMetadata.options), store,
      cleanup: new FirestoreCandidateCleanupStore(cleanupMetadata.options), evidenceRoot: evidence,
      authenticateTask: authorization => Promise.resolve(authorization === "Bearer fixture-only-task-identity") });
    service.listen(0, "127.0.0.1"); await once(service, "listening");
    const address = service.address(); if (!address || typeof address === "string") throw new Error("No owned task listener");
    const request = () => fetch("http://127.0.0.1:" + address.port + "/internal/candidates/verify", { method: "POST",
      headers: { authorization: "Bearer fixture-only-task-identity", "content-type": "application/json" }, body: JSON.stringify(verification[0]) });
    const response = await request(); expect(response.status).toBe(200);
    const receipt: unknown = await response.json(); expect(receipt).toEqual({ runId: "worker-fixture", status: "ready-for-review", verifiedBaseSha: baseSha });
    await expect(access(replayRepo)).rejects.toThrow();
    expect(objects.size).toBe(0); expect((await new FirestoreCandidateCleanupStore(cleanupMetadata.options).get("worker-fixture"))?.status).toBe("cleared");
    const repeated = await request(); expect(repeated.status).toBe(200); expect(await repeated.json()).toEqual(receipt);
    expect(await git(["status", "--porcelain", "--untracked-files=all"])).toBe("");
    await writeFile(join(evidence, "result.json"), JSON.stringify({ kind: "owned-worker-fake-cloud-trusted-task-independent-docker", status: "ready-for-review", baseSha,
      reportDigest: verification[0].reportDigest, acceptedFixes: candidate.report.fixed, privateSourceRemoved: true, trustedCheckoutRemoved: true, cleanupConfirmed: true,
      cloudApis: "fake", paidCalls: 0, fakeProviderCalls: 1 }), { flag: "wx", mode: 0o600 });
    console.log("Owned durable candidate task replay evidence:", evidence);
  } finally {
    try { if (service) await new Promise<void>(resolve => service?.close(() => resolve())); }
    finally {
      objects.clear();
      try { if (created) await stopDockerContainer(name); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  }
});
