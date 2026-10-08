import { z } from "zod";

import {
  repairRepository,
} from "../core/repository.js";
import type {
  RepositoryRepairOptions,
  RepositoryRepairOutput,
} from "../core/repository.js";
import {
  createGitHubRequest,
} from "../reporter/github-publisher.js";
import type { GitHubRequest } from "../reporter/github-publisher.js";
import {
  publishVerifiedPullRequestSuggestions,
} from "../reporter/pr-mode-publisher.js";
import type {
  PublishPullRequestSuggestionsInput,
  PublishPullRequestSuggestionsResult,
} from "../reporter/pr-mode-publisher.js";
import type { ModelPricing } from "../llm/ai-sdk-provider.js";
import { isSourcePath } from "../types/schemas.js";
import type { RunReport } from "../reporter/report.js";

const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const prSchema = z.object({
  head: z.object({
    sha: shaSchema,
    repo: z.object({ full_name: repositorySchema }).passthrough().nullable(),
  }).passthrough(),
}).passthrough();
const fileSchema = z.object({
  filename: z.string().min(1).max(1024),
  status: z.string(),
}).passthrough();

export interface PullRequestActionOptions {
  repoPath: string;
  tempRoot: string;
  runtimeRoot: string;
  repository: string;
  pullNumber: number;
  verifiedHeadSha: string;
  githubToken: string;
  isFork?: boolean;
  noLlm?: boolean;
  offline?: boolean;
  retainEvidence?: boolean;
  maxTasks?: number;
  maxCostUsd?: number;
  pricing?: ModelPricing;
}

export interface PullRequestActionResult {
  status: PublishPullRequestSuggestionsResult["status"] | "read-only" | "blocked";
  suggestions: number;
  handoffs: number;
  reason: string | null;
  report: RunReport;
  evidenceDir: string;
}

export interface PullRequestActionDependencies {
  repairRepository: (
    options: RepositoryRepairOptions,
  ) => Promise<RepositoryRepairOutput>;
  createGitHubRequest: (token: string) => GitHubRequest;
  publishVerifiedPullRequestSuggestions: (
    request: GitHubRequest,
    input: PublishPullRequestSuggestionsInput,
  ) => Promise<PublishPullRequestSuggestionsResult>;
}

const defaults: PullRequestActionDependencies = {
  repairRepository,
  createGitHubRequest,
  publishVerifiedPullRequestSuggestions,
};

async function inspectPullRequest(
  request: GitHubRequest,
  repository: string,
  pullNumber: number,
  verifiedHeadSha: string,
): Promise<{ changedPaths: string[]; isFork: boolean }> {
  const root = `/repos/${repository}/pulls/${pullNumber}`;
  const pr = prSchema.parse(await request("GET", root));
  if (pr.head.sha !== verifiedHeadSha) {
    throw new Error("The pull request checkout does not match the verified head SHA");
  }

  const changed = new Set<string>();
  for (let page = 1; page <= 3; page += 1) {
    const files = z.array(fileSchema).max(100).parse(
      await request("GET", `${root}/files?per_page=100&page=${page}`),
    );
    for (const file of files) {
      if (isSourcePath(file.filename)) changed.add(file.filename);
    }
    if (files.length < 100) break;
    if (page === 3) throw new Error("Pull request file inspection exceeded the explicit limit");
  }

  return {
    changedPaths: [...changed].sort(),
    isFork: pr.head.repo?.full_name !== repository,
  };
}

/**
 * PR mode scopes repair candidates to routes touched by PR source files while
 * preserving the same full final production gate. Forks are always read-only
 * and cannot receive provider credentials or GitHub writes.
 */
export async function runPullRequestAction(
  raw: PullRequestActionOptions,
  dependencies: PullRequestActionDependencies = defaults,
): Promise<PullRequestActionResult> {
  const options = {
    ...raw,
    repository: repositorySchema.parse(raw.repository),
    pullNumber: z.number().int().positive().parse(raw.pullNumber),
    verifiedHeadSha: shaSchema.parse(raw.verifiedHeadSha),
    githubToken: z.string().min(1).parse(raw.githubToken),
  };
  const request = dependencies.createGitHubRequest(options.githubToken);
  const inspected = await inspectPullRequest(
    request,
    options.repository,
    options.pullNumber,
    options.verifiedHeadSha,
  );
  const fork = options.isFork === true || inspected.isFork;

  const repair = await dependencies.repairRepository({
    repoPath: options.repoPath,
    tempRoot: options.tempRoot,
    runtimeRoot: options.runtimeRoot,
    dryRun: true,
    changedPaths: inspected.changedPaths,
    noLlm: fork ? true : options.noLlm === true,
    ...(options.offline === undefined ? {} : { offline: options.offline }),
    ...(options.retainEvidence === undefined
      ? {}
      : { retainEvidence: options.retainEvidence }),
    ...(options.maxTasks === undefined ? {} : { maxTasks: options.maxTasks }),
    maxCostUsd: fork ? 0 : (options.maxCostUsd ?? 0),
    ...(fork || options.pricing === undefined ? {} : { pricing: options.pricing }),
  });

  if (repair.report.status !== "verified" || repair.report.final.failures.length !== 0) {
    return {
      status: "blocked",
      suggestions: 0,
      handoffs: 0,
      reason: "Final verification did not pass",
      report: repair.report,
      evidenceDir: repair.evidenceDir,
    };
  }

  const checks = ["build", "typecheck", "lint", "tests"] as const;
  const checksPassed = checks.every(name => {
    const matched = repair.report.checks.filter(item => item.check === name);
    return matched.length === 1 && matched[0]?.available === true && matched[0].status === "passed";
  });
  if (!checksPassed) {
    return {
      status: "blocked",
      suggestions: 0,
      handoffs: 0,
      reason: "Required production checks were not all available and passed",
      report: repair.report,
      evidenceDir: repair.evidenceDir,
    };
  }

  if (fork) {
    return {
      status: "read-only",
      suggestions: 0,
      handoffs: repair.groups.length,
      reason: "Fork pull requests run without LLM credentials or GitHub writes",
      report: repair.report,
      evidenceDir: repair.evidenceDir,
    };
  }

  if (repair.groups.length === 0) {
    return {
      status: "unchanged",
      suggestions: 0,
      handoffs: 0,
      reason: null,
      report: repair.report,
      evidenceDir: repair.evidenceDir,
    };
  }

  const published = await dependencies.publishVerifiedPullRequestSuggestions(
    request,
    {
      repository: options.repository,
      pullNumber: options.pullNumber,
      verifiedHeadSha: options.verifiedHeadSha,
      groups: repair.groups,
    },
  );
  return {
    ...published,
    reason: null,
    report: repair.report,
    evidenceDir: repair.evidenceDir,
  };
}
