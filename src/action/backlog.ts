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
  publishVerifiedPullRequest,
} from "../reporter/github-publisher.js";
import type {
  GitHubRequest,
  PublishInput,
  PublishResult,
} from "../reporter/github-publisher.js";
import {
  renderPullRequestReport,
} from "../reporter/report.js";
import type { RunReport } from "../reporter/report.js";
import type { ModelPricing } from "../llm/ai-sdk-provider.js";

const repositorySchema = z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const branchSchema = z.string().min(1).max(255).refine(
  value =>
    ![...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || "~^:?*[\\".includes(char)) &&
    !value.startsWith(".") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.includes("..") &&
    !value.includes("@{"),
  "Invalid base branch",
);

export interface BacklogActionOptions {
  repoPath: string;
  tempRoot: string;
  runtimeRoot: string;
  repository: string;
  baseBranch: string;
  verifiedBaseSha: string;
  githubToken: string;
  publisherLogin: string;
  noLlm?: boolean;
  offline?: boolean;
  retainEvidence?: boolean;
  maxTasks?: number;
  maxCostUsd?: number;
  pricing?: ModelPricing;
}

export interface BacklogActionResult {
  status: PublishResult["status"] | "blocked";
  reason: string | null;
  prUrl: string | null;
  report: RunReport;
  evidenceDir: string;
}

export interface BacklogActionDependencies {
  repairRepository: (
    options: RepositoryRepairOptions,
  ) => Promise<RepositoryRepairOutput>;
  createGitHubRequest: (token: string) => GitHubRequest;
  publishVerifiedPullRequest: (
    request: GitHubRequest,
    input: PublishInput,
  ) => Promise<PublishResult>;
}

const defaultDependencies: BacklogActionDependencies = {
  repairRepository,
  createGitHubRequest,
  publishVerifiedPullRequest,
};

const requiredChecks = ["build", "typecheck", "lint", "tests"] as const;

function productionChecksPassed(report: RunReport): boolean {
  return requiredChecks.every(required => {
    const matches = report.checks.filter(check => check.check === required);
    return (
      matches.length === 1 &&
      matches[0]?.available === true &&
      matches[0].status === "passed"
    );
  });
}

/**
 * GitHub backlog mode verifies in Docker and publishes from the verified patch
 * groups through the Git Data API. The checked-out target tree is never used
 * as the publication mechanism and is left unchanged by this coordinator.
 */
export async function runBacklogAction(
  rawOptions: BacklogActionOptions,
  dependencies: BacklogActionDependencies = defaultDependencies,
): Promise<BacklogActionResult> {
  const options = {
    ...rawOptions,
    repository: repositorySchema.parse(rawOptions.repository),
    baseBranch: branchSchema.parse(rawOptions.baseBranch),
    verifiedBaseSha: shaSchema.parse(rawOptions.verifiedBaseSha),
    publisherLogin: z.string().min(1).max(100).parse(rawOptions.publisherLogin),
    githubToken: z.string().min(1).parse(rawOptions.githubToken),
  };

  const repair = await dependencies.repairRepository({
    repoPath: options.repoPath,
    tempRoot: options.tempRoot,
    runtimeRoot: options.runtimeRoot,
    dryRun: true,
    noLlm: options.noLlm === true,
    ...(options.offline === undefined ? {} : { offline: options.offline }),
    ...(options.retainEvidence === undefined
      ? {}
      : { retainEvidence: options.retainEvidence }),
    ...(options.maxTasks === undefined ? {} : { maxTasks: options.maxTasks }),
    ...(options.maxCostUsd === undefined
      ? {}
      : { maxCostUsd: options.maxCostUsd }),
    ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
  });

  if (repair.report.status !== "verified" || repair.report.final.failures.length !== 0) {
    return {
      status: "blocked",
      reason: "Final verification did not pass",
      prUrl: null,
      report: repair.report,
      evidenceDir: repair.evidenceDir,
    };
  }

  if (!productionChecksPassed(repair.report)) {
    return {
      status: "blocked",
      reason: "Required production checks were not all available and passed",
      prUrl: null,
      report: repair.report,
      evidenceDir: repair.evidenceDir,
    };
  }

  if (repair.groups.length === 0) {
    return {
      status: "unchanged",
      reason: null,
      prUrl: null,
      report: repair.report,
      evidenceDir: repair.evidenceDir,
    };
  }

  const acceptedFixIds = repair.report.final.acceptedFixIds;
  const request = dependencies.createGitHubRequest(options.githubToken);
  const published = await dependencies.publishVerifiedPullRequest(request, {
    repository: options.repository,
    baseBranch: options.baseBranch,
    verifiedBaseSha: options.verifiedBaseSha,
    actorLogin: options.publisherLogin,
    title: "Verified accessibility repairs",
    report: renderPullRequestReport(repair.report),
    verification: {
      acceptedFixIds,
      failures: [],
      buildPassed: true,
    },
    groups: repair.groups,
  });

  return {
    status: published.status,
    reason:
      published.status === "preserved-human"
        ? "Existing repair branch contains human-authored commits and was preserved"
        : null,
    prUrl: published.url,
    report: repair.report,
    evidenceDir: repair.evidenceDir,
  };
}
