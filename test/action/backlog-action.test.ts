import { expect, it } from "vitest";

import { runBacklogAction } from "../../src/action/backlog.js";
import type { RepositoryRepairOutput } from "../../src/core/repository.js";
import type { PublishInput, PublishResult } from "../../src/reporter/github-publisher.js";

const baseSha = "a".repeat(40);
const checks = ["build", "typecheck", "lint", "tests"] as const;

function repairOutput(groups = true): RepositoryRepairOutput {
  return {
    evidenceDir: "/tmp/accesswright-evidence",
    llm: { status: "disabled", reason: "disabled by --no-llm" },
    sandbox: "docker",
    groups: groups
      ? [
          {
            id: "fix-1",
            ruleId: "button-name",
            criterion: "4.1.2",
            perPatchAccepted: true,
            changes: [
              {
                path: "components/Button.tsx",
                before: "<button></button>\n",
                after: '<button aria-label="Save"></button>\n',
              },
            ],
          },
        ]
      : [],
    report: {
      schemaVersion: 1,
      startedAt: "2026-10-07T00:00:00.000Z",
      finishedAt: "2026-10-07T00:00:01.000Z",
      durationMs: 1000,
      status: "verified",
      applied: false,
      fixed: groups ? 1 : 0,
      rejected: 0,
      needsHuman: 0,
      ignored: 0,
      attempts: groups ? 1 : 0,
      providerVerification: "not-run",
      unknownUsage: false,
      usage: { inputTokens: 0, outputTokens: 0, spentUsd: 0 },
      checks: checks.map(check => ({
        check,
        available: true,
        status: "passed" as const,
        durationMs: 1,
        exitCode: 0,
        failureIds: [],
      })),
      outcomes: groups
        ? [
            {
              id: "fix-1",
              ruleId: "button-name",
              criterion: "4.1.2",
              route: "llm",
              status: "verified" as const,
              reason: null,
            },
          ]
        : [],
      final: {
        acceptedFixIds: groups ? ["fix-1"] : [],
        droppedFixIds: [],
        failures: [],
      },
    },
  };
}

const options = {
  repoPath: "/workspace",
  tempRoot: "/runner-temp/accesswright",
  runtimeRoot: "/action",
  repository: "owner/repo",
  baseBranch: "main",
  verifiedBaseSha: baseSha,
  githubToken: "fixture-token",
  publisherLogin: "github-actions[bot]",
  noLlm: true,
  maxCostUsd: 0,
  maxTasks: 20,
};

it("runs the verified coordinator in dry-run mode and publishes only its accepted groups", async () => {
  let publishInput: PublishInput | undefined;
  const output = repairOutput();
  const published: PublishResult = {
    status: "created",
    branch: "accesswright/fixes-main",
    number: 7,
    url: "https://github.com/owner/repo/pull/7",
    commits: ["b".repeat(40)],
  };
  const result = await runBacklogAction(options, {
    repairRepository: repairOptions => {
      expect(repairOptions).toMatchObject({
        repoPath: "/workspace",
        dryRun: true,
        noLlm: true,
        maxCostUsd: 0,
        maxTasks: 20,
      });
      return Promise.resolve(output);
    },
    createGitHubRequest: token => {
      expect(token).toBe("fixture-token");
      return () => Promise.resolve(null);
    },
    publishVerifiedPullRequest: (_request, input) => {
      publishInput = input;
      return Promise.resolve(published);
    },
  });

  expect(result).toMatchObject({
    status: "created",
    prUrl: "https://github.com/owner/repo/pull/7",
    report: output.report,
  });
  expect(publishInput).toMatchObject({
    repository: "owner/repo",
    baseBranch: "main",
    verifiedBaseSha: baseSha,
    actorLogin: "github-actions[bot]",
    verification: {
      acceptedFixIds: ["fix-1"],
      failures: [],
      buildPassed: true,
    },
    groups: output.groups,
  });
  expect(publishInput?.report).toContain("Accessibility repair verification");
});

it("blocks publication when any required production check is unavailable", async () => {
  const output = repairOutput();
  output.report.checks = output.report.checks.map(check =>
    check.check === "tests"
      ? { ...check, available: false, status: "unavailable", exitCode: null }
      : check,
  );
  let writes = 0;
  const result = await runBacklogAction(options, {
    repairRepository: () => Promise.resolve(output),
    createGitHubRequest: () => () => {
      writes += 1;
      return Promise.resolve(null);
    },
    publishVerifiedPullRequest: () => {
      writes += 1;
      throw new Error("must not publish");
    },
  });
  expect(result.status).toBe("blocked");
  expect(result.reason).toMatch(/production checks/i);
  expect(writes).toBe(0);
});

it("rejects contradictory final-verification evidence before constructing a GitHub client", async () => {
  const output = repairOutput();
  output.report.final.failures.push({ check: "violations", id: "new-regression" });
  let calls = 0;
  const result = await runBacklogAction(options, {
    repairRepository: () => Promise.resolve(output),
    createGitHubRequest: () => { calls += 1; return () => Promise.resolve(null); },
    publishVerifiedPullRequest: () => { calls += 1; throw new Error("unverified publication"); },
  });
  expect(result.status).toBe("blocked");
  expect(calls).toBe(0);
});

it("does not call GitHub when the verified backlog has no accepted fix groups", async () => {
  const output = repairOutput(false);
  let githubCalls = 0;
  const result = await runBacklogAction(options, {
    repairRepository: () => Promise.resolve(output),
    createGitHubRequest: () => {
      githubCalls += 1;
      return () => Promise.resolve(null);
    },
    publishVerifiedPullRequest: () => {
      githubCalls += 1;
      throw new Error("must not publish");
    },
  });
  expect(result).toMatchObject({ status: "unchanged", prUrl: null });
  expect(githubCalls).toBe(0);
});
