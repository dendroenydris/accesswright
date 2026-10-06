import { createHash } from "node:crypto";

export interface PullRequestCommit {
  sha: string;
  madeByAccesswright: boolean;
}

export interface ExistingPullRequest {
  number: number;
  branch: string;
  commits: PullRequestCommit[];
}

export interface PullRequestStateAdapter {
  findOpenPullRequest(branch: string): Promise<ExistingPullRequest | null>;
}

export type PullRequestTargetAction = "create" | "update" | "preserve-human";

export interface PullRequestTarget {
  action: PullRequestTargetAction;
  branch: string;
  pullRequestNumber: number | null;
}

function branchSlug(baseBranch: string): string {
  const normalized = baseBranch
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized.length === 0 ? "base" : normalized;
}

export function fixBranchName(baseBranch: string): string {
  if (baseBranch.trim().length === 0) {
    throw new Error("Base branch must not be empty");
  }

  const digest = createHash("sha256")
    .update(baseBranch)
    .digest("hex")
    .slice(0, 10);
  return `accesswright/fix-${branchSlug(baseBranch)}-${digest}`;
}

export async function resolvePullRequestTarget(
  adapter: PullRequestStateAdapter,
  baseBranch: string,
): Promise<PullRequestTarget> {
  const branch = fixBranchName(baseBranch);
  const existing = await adapter.findOpenPullRequest(branch);

  if (existing === null) {
    return {
      action: "create",
      branch,
      pullRequestNumber: null,
    };
  }

  if (existing.branch !== branch) {
    throw new Error(
      `Pull request state returned a different branch: expected ${branch}, got ${existing.branch}`,
    );
  }

  const hasHumanCommit = existing.commits.some(
    (commit) => !commit.madeByAccesswright,
  );

  return {
    action: hasHumanCommit ? "preserve-human" : "update",
    branch,
    pullRequestNumber: existing.number,
  };
}
