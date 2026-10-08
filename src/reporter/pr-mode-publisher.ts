import { z } from "zod";

import type { GitHubRequest, PublishInput } from "./github-publisher.js";
import { planPullRequestSuggestions } from "./pr-suggestions.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const pull = z.object({ head: z.object({ sha }).passthrough() }).passthrough();
const file = z.object({
  filename: z.string().min(1).max(1024),
  status: z.string(),
  patch: z.string().max(1_000_000).nullable().optional(),
}).passthrough();

export interface PublishPullRequestSuggestionsInput {
  repository: string;
  pullNumber: number;
  verifiedHeadSha: string;
  groups: PublishInput["groups"];
}

export interface PublishPullRequestSuggestionsResult {
  status: "published" | "handoff" | "unchanged";
  suggestions: number;
  handoffs: number;
}

function handoffBody(
  handoffs: Array<{ fixId: string; path: string; reason: string }>,
): string {
  return [
    "Accesswright verified additional accessibility fixes that cannot be represented as GitHub suggestions inside the current PR diff.",
    "",
    ...handoffs.map(item =>
      `- ${item.path}: ${item.reason} (fix group ${item.fixId})`,
    ),
    "",
    "Run the Accesswright CLI against this PR head to review/apply these verified source changes. No out-of-diff source was written by PR mode.",
  ].join("\n");
}

function suggestionBody(replacement: string): string {
  const fence = String.fromCharCode(96).repeat(3);
  return `${fence}suggestion\n${replacement}\n${fence}`;
}

export async function publishVerifiedPullRequestSuggestions(
  request: GitHubRequest,
  raw: PublishPullRequestSuggestionsInput,
): Promise<PublishPullRequestSuggestionsResult> {
  const input = {
    repository: repository.parse(raw.repository),
    pullNumber: z.number().int().positive().parse(raw.pullNumber),
    verifiedHeadSha: sha.parse(raw.verifiedHeadSha),
    groups: raw.groups,
  };
  const root = `/repos/${input.repository}`;
  const prPath = `${root}/pulls/${input.pullNumber}`;
  const readHead = async () =>
    pull.parse(await request("GET", prPath)).head.sha;

  if (await readHead() !== input.verifiedHeadSha) {
    throw new Error("The pull request head changed after verification");
  }

  const files: Array<{ path: string; patch: string | null }> = [];
  for (let page = 1; page <= 3; page += 1) {
    const batch = z.array(file).max(100).parse(
      await request("GET", `${prPath}/files?per_page=100&page=${page}`),
    );
    for (const item of batch) {
      files.push({ path: item.filename, patch: item.patch ?? null });
    }
    if (batch.length < 100) break;
    if (page === 3) {
      throw new Error("Pull request file inspection exceeded the explicit limit");
    }
  }

  const plan = planPullRequestSuggestions({ groups: input.groups, files });
  if (plan.suggestions.length === 0 && plan.cliHandoffs.length === 0) {
    return { status: "unchanged", suggestions: 0, handoffs: 0 };
  }

  if (await readHead() !== input.verifiedHeadSha) {
    throw new Error("The pull request head changed before publication");
  }

  if (plan.suggestions.length > 0) {
    const comments = plan.suggestions.map(item => ({
      path: item.path,
      line: item.endLine,
      side: "RIGHT",
      ...(item.startLine === item.endLine
        ? {}
        : { start_line: item.startLine, start_side: "RIGHT" }),
      body: suggestionBody(item.replacement),
    }));
    await request("POST", `${prPath}/reviews`, {
      commit_id: input.verifiedHeadSha,
      event: "COMMENT",
      body: plan.cliHandoffs.length > 0
        ? handoffBody(plan.cliHandoffs)
        : "Accesswright verified these accessibility fixes against the PR head before suggesting them.",
      comments,
    });
    return {
      status: "published",
      suggestions: plan.suggestions.length,
      handoffs: plan.cliHandoffs.length,
    };
  }

  await request("POST", `${root}/issues/${input.pullNumber}/comments`, {
    body: handoffBody(plan.cliHandoffs),
  });
  return { status: "handoff", suggestions: 0, handoffs: plan.cliHandoffs.length };
}
