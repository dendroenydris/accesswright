import { describe, expect, it } from "vitest";

import {
  fixBranchName,
  resolvePullRequestTarget,
} from "../../src/reporter/pr-state.js";
import type {
  ExistingPullRequest,
  PullRequestStateAdapter,
} from "../../src/reporter/pr-state.js";

class FakeAdapter implements PullRequestStateAdapter {
  readonly lookups: string[] = [];
  private readonly existing: ExistingPullRequest | null;

  constructor(existing: ExistingPullRequest | null) {
    this.existing = existing;
  }

  findOpenPullRequest(branch: string): Promise<ExistingPullRequest | null> {
    this.lookups.push(branch);
    return Promise.resolve(this.existing);
  }
}

describe("fixBranchName", () => {
  it("is deterministic for the same base branch and distinct for colliding slugs", () => {
    expect(fixBranchName("main")).toBe(fixBranchName("main"));
    expect(fixBranchName("feature/a-b")).not.toBe(fixBranchName("feature-a/b"));
  });
});

describe("resolvePullRequestTarget", () => {
  it("creates a new logical PR target when none exists", async () => {
    const adapter = new FakeAdapter(null);

    const result = await resolvePullRequestTarget(adapter, "main");

    expect(result).toEqual({
      action: "create",
      branch: fixBranchName("main"),
      pullRequestNumber: null,
    });
    expect(adapter.lookups).toEqual([fixBranchName("main")]);
  });

  it("updates the same PR on rerun when every branch commit is from accesswright", async () => {
    const branch = fixBranchName("main");
    const adapter = new FakeAdapter({
      number: 42,
      branch,
      commits: [
        { sha: "a".repeat(40), madeByAccesswright: true },
        { sha: "b".repeat(40), madeByAccesswright: true },
      ],
    });

    await expect(resolvePullRequestTarget(adapter, "main")).resolves.toEqual({
      action: "update",
      branch,
      pullRequestNumber: 42,
    });
  });

  it("preserves a branch containing a human commit instead of force-updating it", async () => {
    const branch = fixBranchName("main");
    const adapter = new FakeAdapter({
      number: 42,
      branch,
      commits: [
        { sha: "a".repeat(40), madeByAccesswright: true },
        { sha: "b".repeat(40), madeByAccesswright: false },
      ],
    });

    await expect(resolvePullRequestTarget(adapter, "main")).resolves.toEqual({
      action: "preserve-human",
      branch,
      pullRequestNumber: 42,
    });
  });

  it("fails closed when the adapter returns a PR for a different branch", async () => {
    const adapter = new FakeAdapter({
      number: 42,
      branch: "unexpected",
      commits: [],
    });

    await expect(resolvePullRequestTarget(adapter, "main")).rejects.toThrow(
      /different branch/i,
    );
  });
});
