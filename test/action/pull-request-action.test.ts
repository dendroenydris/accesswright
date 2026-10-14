import { expect, it } from "vitest";

import { runPullRequestAction } from "../../src/action/pull-request.js";
import type { RepositoryRepairOutput } from "../../src/core/repository.js";
import type { GitHubRequest } from "../../src/reporter/github-publisher.js";

const head = "a".repeat(40);

function output(): RepositoryRepairOutput {
  return {
    evidenceDir: "/tmp/evidence",
    llm: { status: "disabled", reason: "disabled by --no-llm" },
    sandbox: "docker",
    groups: [{
      id: "fix-1",
      ruleId: "button-name",
      criterion: "4.1.2",
      perPatchAccepted: true,
      changes: [{ path: "components/Button.tsx", before: "before", after: "after" }],
    }],
    report: {
      schemaVersion: 1,
      startedAt: "2026-10-07T00:00:00.000Z",
      finishedAt: "2026-10-07T00:00:01.000Z",
      durationMs: 1000,
      status: "verified",
      applied: false,
      fixed: 1,
      rejected: 0,
      needsHuman: 0,
      ignored: 0,
      attempts: 1,
      providerVerification: "not-run",
      unknownUsage: false,
      usage: { inputTokens: 0, outputTokens: 0, spentUsd: 0 },
      checks: ["build", "typecheck", "lint", "tests"].map(check => ({
        check: check as "build" | "typecheck" | "lint" | "tests",
        available: true,
        status: "passed" as const,
        durationMs: 1,
        exitCode: 0,
        failureIds: [],
      })),
      outcomes: [{ id: "fix-1", ruleId: "button-name", criterion: "4.1.2", route: "llm", status: "verified", reason: null }],
      final: { acceptedFixIds: ["fix-1"], droppedFixIds: [], failures: [] },
    },
  };
}

const options = {
  repoPath: "/workspace",
  tempRoot: "/tmp/accesswright",
  runtimeRoot: "/action",
  repository: "owner/repo",
  pullNumber: 7,
  verifiedHeadSha: head,
  githubToken: "fixture-token",
  noLlm: false,
  maxCostUsd: 0,
};

function requestFixture(writes: string[]): GitHubRequest {
  return (method, path) => {
    if (method !== "GET") writes.push(path);
    if (method === "GET" && path === "/repos/owner/repo/pulls/7") {
      return Promise.resolve({ id: 731, title: "real GitHub payload", head: { sha: head, ref: "review", repo: { full_name: "owner/repo", private: true } }, base: { ref: "main" } });
    }
    if (method === "GET" && path === "/repos/owner/repo/pulls/7/files?per_page=100&page=1") {
      return Promise.resolve([{ filename: "components/Button.tsx", status: "modified", patch: "@@ -1 +1 @@\n-before\n+current" }]);
    }
    return Promise.reject(new Error("Unexpected request " + method + " " + path));
  };
}

it("scopes repair tasks to PR source files and passes only finally verified groups to suggestion publication", async () => {
  const writes: string[] = [];
  const repair = output();
  let seenRepair: unknown;
  let published = false;
  const result = await runPullRequestAction(options, {
    repairRepository: repairOptions => {
      seenRepair = repairOptions;
      return Promise.resolve(repair);
    },
    createGitHubRequest: token => {
      expect(token).toBe("fixture-token");
      return requestFixture(writes);
    },
    publishVerifiedPullRequestSuggestions: (_request, input) => {
      published = true;
      expect(input).toMatchObject({
        repository: "owner/repo",
        pullNumber: 7,
        verifiedHeadSha: head,
        groups: repair.groups,
      });
      return Promise.resolve({ status: "published", suggestions: 1, handoffs: 0 });
    },
  });
  expect(seenRepair).toMatchObject({
    repoPath: "/workspace",
    dryRun: true,
    changedPaths: ["components/Button.tsx"],
    noLlm: false,
  });
  expect(published).toBe(true);
  expect(writes).toEqual([]);
  expect(result).toMatchObject({ status: "published", suggestions: 1, handoffs: 0 });
});

it("forces fork pull requests to no-LLM read-only mode and performs no GitHub write", async () => {
  const writes: string[] = [];
  let seenRepair: unknown;
  let publisherCalls = 0;
  const result = await runPullRequestAction({ ...options, isFork: true }, {
    repairRepository: repairOptions => {
      seenRepair = repairOptions;
      return Promise.resolve(output());
    },
    createGitHubRequest: () => requestFixture(writes),
    publishVerifiedPullRequestSuggestions: () => {
      publisherCalls += 1;
      throw new Error("fork mode must not publish");
    },
  });
  expect(seenRepair).toMatchObject({ noLlm: true, maxCostUsd: 0 });
  expect(result.status).toBe("read-only");
  expect(publisherCalls).toBe(0);
  expect(writes).toEqual([]);
});

it("blocks publication when final verification did not pass", async () => {
  const writes: string[] = [];
  const blocked = output();
  blocked.report.status = "blocked";
  blocked.report.final.failures = [{ check: "build", id: "failure" }];
  let publisherCalls = 0;
  const result = await runPullRequestAction(options, {
    repairRepository: () => Promise.resolve(blocked),
    createGitHubRequest: () => requestFixture(writes),
    publishVerifiedPullRequestSuggestions: () => {
      publisherCalls += 1;
      throw new Error("must not publish");
    },
  });
  expect(result.status).toBe("blocked");
  expect(publisherCalls).toBe(0);
  expect(writes).toEqual([]);
});

it("never publishes PR suggestions when any production check is unavailable", async () => {
  const writes: string[] = [];
  const repair = output();
  repair.report.checks = [
    { check: "build", available: true, status: "passed", durationMs: 1, exitCode: 0, failureIds: [] },
    { check: "typecheck", available: true, status: "passed", durationMs: 1, exitCode: 0, failureIds: [] },
    { check: "lint", available: true, status: "passed", durationMs: 1, exitCode: 0, failureIds: [] },
    { check: "tests", available: false, status: "unavailable", durationMs: 0, exitCode: null, failureIds: [] },
  ];
  let publishCalls = 0;
  const result = await runPullRequestAction(options, {
    repairRepository: () => Promise.resolve(repair),
    createGitHubRequest: () => requestFixture(writes),
    publishVerifiedPullRequestSuggestions: () => { publishCalls += 1; throw new Error("must not publish"); },
  });
  expect(result.status).toBe("blocked");
  expect(result.reason).toMatch(/production checks/i);
  expect(publishCalls).toBe(0);
  expect(writes).toEqual([]);
});
