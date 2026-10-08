import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { runPullRequestAction } from "../../src/action/pull-request.js";
import { repairRepository } from "../../src/core/repository.js";
import type { GitHubRequest } from "../../src/reporter/github-publisher.js";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";

it("PR mode verifies a real Next app in Docker before proposing in-diff changes, without changing the checkout", async () => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
  await mkdir(tempRoot, { recursive: true });
  const repoPath = await mkdtemp(join(tempRoot, "pr-mode-fixture-"));
  await createNextIntegrationFixture(repoPath);
  const original = await readFile(join(repoPath, "components/Controls.tsx"), "utf8");
  const sha = "a".repeat(40);
  const requests: string[] = [];
  const request: GitHubRequest = (method, path) => {
    requests.push(method + " " + path);
    if (method !== "GET") throw new Error("Unexpected remote write");
    if (path === "/repos/owner/repo/pulls/7") {
      return Promise.resolve({
        id: 71,
        state: "open",
        head: { sha, ref: "feature/a11y", repo: { full_name: "owner/repo", private: true } },
        base: { ref: "main" },
      });
    }
    if (path === "/repos/owner/repo/pulls/7/files?per_page=100&page=1") {
      return Promise.resolve([{ filename: "components/Controls.tsx", status: "modified", patch: "@@ -1,1 +1,1 @@\n-old\n+new" }]);
    }
    throw new Error("Unexpected GitHub read: " + path);
  };
  let published = false;
  const result = await runPullRequestAction({
    repoPath,
    tempRoot,
    runtimeRoot: process.cwd(),
    repository: "owner/repo",
    pullNumber: 7,
    verifiedHeadSha: sha,
    githubToken: "fixture-only",
    noLlm: true,
    offline: true,
    maxCostUsd: 0,
  }, {
    repairRepository,
    createGitHubRequest: () => request,
    publishVerifiedPullRequestSuggestions: (_transport, input) => {
      published = true;
      expect(input.verifiedHeadSha).toBe(sha);
      expect(input.groups.length).toBeGreaterThan(0);
      expect(input.groups.every(group => group.perPatchAccepted)).toBe(true);
      expect(input.groups.every(group => group.changes.every(change => change.path.startsWith("components/") || change.path.startsWith("app/")))).toBe(true);
      return Promise.resolve({ status: "published", suggestions: input.groups.length, handoffs: 0 });
    },
  });
  expect(result.status).toBe("published");
  expect(result.report.status).toBe("verified");
  expect(result.report.fixed).toBeGreaterThan(0);
  expect(result.report.checks.map(check => check.status)).toEqual(["passed", "passed", "passed", "passed"]);
  expect(result.report.applied).toBe(false);
  expect(published).toBe(true);
  expect(requests.every(value => value.startsWith("GET "))).toBe(true);
  expect(await readFile(join(repoPath, "components/Controls.tsx"), "utf8")).toBe(original);
  const report = await readFile(join(result.evidenceDir, "accesswright-report.md"), "utf8");
  expect(report).toContain("# Accesswright evidence report");
  console.log("PR-mode real Docker/Next/verifier evidence:", result.evidenceDir);
});
