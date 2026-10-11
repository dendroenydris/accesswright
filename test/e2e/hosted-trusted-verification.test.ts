import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";

import { repairRepository } from "../../src/core/repository.js";
import { HostedPatchAgent } from "../../src/hosted/agent-api.js";
import { createHostedAgentServer } from "../../src/hosted/agent-http.js";
import { InMemoryHostedAgentRunStore } from "../../src/hosted/agent-run-store.js";
import { hostedReportDigest, InMemoryHostedRunStore } from "../../src/hosted/run-workflow.js";
import { verifyHostedCandidate } from "../../src/hosted/trusted-verifier.js";
import { DurableSpendLedger } from "../../src/llm/durable-spend.js";
import { listSnapshotFiles } from "../../src/runner/patch-journal.js";
import { removePlatformMetadata } from "../../src/sandbox/platform-metadata.js";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";

it("requires a second real Docker verifier before a private Hosted service accepts a job for review", async () => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, "hosted-trusted-fixture-"));
  const repoPath = join(root, "repo");
  const privateTemp = join(root, "private-runs");
  try {
    await createNextIntegrationFixture(repoPath);
    const files = await listSnapshotFiles(repoPath);
    const git = async (args: string[]) => (await execa("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", ...args], {
      cwd: repoPath, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, extendEnv: false,
    })).stdout.trim();
    await git(["init"]);
    await git(["add", "--", ...files]);
    await git(["commit", "-m", "fixture"]);
    const baseSha = await git(["rev-parse", "HEAD"]);
    const original = await readFile(join(repoPath, "components/Controls.tsx"), "utf8");
    const candidate = await repairRepository({ repoPath, tempRoot: privateTemp, runtimeRoot: process.cwd(), noLlm: true, offline: true, dryRun: true });
    expect(candidate.report).toMatchObject({ status: "verified", fixed: 2, applied: false, providerVerification: "not-run" });
    expect(await readFile(join(repoPath, "components/Controls.tsx"), "utf8")).toBe(original);
    // The owned fixture may acquire AppleDouble files on macOS volumes; the verifier still requires a clean checkout.
    await removePlatformMetadata(repoPath);
    expect(await git(["status", "--porcelain", "--untracked-files=all"])).toBe("");
    const input = { report: candidate.report, patches: candidate.groups.map(group => ({ taskId: group.id, changes: group.changes })) };
    const provider = new FakeLlmProvider([]);
    const ledger = await DurableSpendLedger.initialize(join(root, "spend.json"), { maxUsd: 1, history: [] });
    const agent = new HostedPatchAgent({
      model: { provider: "openai", id: "fixture-only", reasoningEffort: "high" }, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      maxInputTokens: 1000, maxOutputTokens: 1000, maxCostUsdPerRun: 0.1, ledgerForRun: () => Promise.resolve(ledger),
      provider, runStore: new InMemoryHostedAgentRunStore(),
    });
    const token = await agent.registerRun({ runId: "hosted-fixture", repository: "owned/fixture", installationId: 42 });
    const store = new InMemoryHostedRunStore();
    let independentChecks = 0;
    const server = createHostedAgentServer({ agent, store, verifyTrustedResult: async (runId, digest) => {
      if (runId !== "hosted-fixture" || digest !== hostedReportDigest(input.report)) return null;
      independentChecks++;
      return verifyHostedCandidate({ repoPath, verifiedBaseSha: baseSha, tempRoot: privateTemp, runtimeRoot: process.cwd(),
        reconciled: { usage: { inputTokens: 0, outputTokens: 0, spentUsd: 0 }, unknownUsage: false, providerVerification: "not-run" } }, input);
    } });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Hosted fixture server has no port");
    const origin = "http://127.0.0.1:" + address.port + "/runs/hosted-fixture";
    const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
    try {
      const submitted = await fetch(origin + "/results", { method: "POST", headers, body: JSON.stringify(input.report) });
      expect(submitted.status).toBe(202);
      await submitted.arrayBuffer();
      expect(store.get("hosted-fixture")?.status).toBe("recorded");
      expect(independentChecks).toBe(0);
      const finished = await fetch(origin + "/finish", { method: "POST", headers, body: "{}" });
      expect(await finished.json()).toMatchObject({ status: "ready-for-review", verifiedBaseSha: baseSha });
      expect(finished.status).toBe(200);
      expect(independentChecks).toBe(1);
      expect(provider.requests).toHaveLength(0);
      expect(store.get("hosted-fixture")).toMatchObject({ acceptedFixes: 2, status: "ready-for-review" });
      expect(JSON.stringify(store.get("hosted-fixture"))).not.toContain(original);
      expect(await readFile(join(repoPath, "components/Controls.tsx"), "utf8")).toBe(original);
      expect(await git(["status", "--porcelain", "--untracked-files=all"])).toBe("");
      const evidence = await mkdtemp(join(tempRoot, "hosted-trusted-evidence-"));
      await writeFile(join(evidence, "result.json"), JSON.stringify({ kind: "owned-fixture-independent-docker-verification", baseSha, reportDigest: hostedReportDigest(input.report), acceptedFixes: 2, independentChecks, paidCalls: 0 }, null, 2), { flag: "wx", mode: 0o600 });
      console.log("Hosted independent Docker verification evidence:", evidence);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
