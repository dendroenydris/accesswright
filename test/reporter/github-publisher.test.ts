import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publishVerifiedPullRequest, createGitHubRequest } from "../../src/reporter/github-publisher.js";
import type { GitHubRequest, PublishInput } from "../../src/reporter/github-publisher.js";
import { fixBranchName } from "../../src/reporter/pr-state.js";

const base = "a".repeat(40);
const existingHead = "b".repeat(40);
const input: PublishInput = {
  repository: "owner/repo", baseBranch: "main", verifiedBaseSha: base, actorLogin: "github-actions[bot]",
  title: "Verified accessibility repairs", report: "Automated checks passed; human review is still required.",
  verification: { acceptedFixIds: ["fix-1"], failures: [], buildPassed: true },
  groups: [{ id: "fix-1", ruleId: "button-name", criterion: "4.1.2", perPatchAccepted: true,
    changes: [{ path: "components/Button.tsx", before: "before\n", after: "after\n" }] }],
};

class FixtureApi {
  calls: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = [];
  files = new Map([["components/Button.tsx", "before\n"]]);
  currentBase = base;
  branchHead: string | null = null;
  existing = false;
  human = false;
  race = false;
  headReads = 0;
  writes = 0;
  extraOrphanFile = false;
  webFlow = false;
  authorLogin: string | null = "github-actions[bot]";
  verification: { verified: boolean; reason: string } | undefined;
  private commit(message: string) {
    return { sha: existingHead, parents: [{ sha: base }], commit: { message, ...(this.verification === undefined ? {} : { verification: this.verification }) },
      committer: { login: this.human ? "human" : this.webFlow ? "web-flow" : "github-actions[bot]" },
      author: this.authorLogin === null ? null : { login: this.authorLogin } };
  }
  request: GitHubRequest = (method, path, body) => {
    this.calls.push({ method, path, body });
    if (method !== "GET") this.writes += 1;
    const relative = path.replace("/repos/owner/repo", "");
    if (relative === "/git/ref/heads/main") return Promise.resolve({ object: { sha: this.currentBase } });
    if (relative.startsWith("/git/ref/heads/accesswright")) {
      this.headReads += 1;
      return Promise.resolve(this.branchHead === null ? null : { object: { sha: this.race && this.headReads > 1 ? "c".repeat(40) : this.branchHead } });
    }
    if (relative.startsWith("/pulls?") && method === "GET") return Promise.resolve(this.existing ? [{ number: 7, body: "Human introduction.\n", head: { sha: existingHead, ref: fixBranchName("main"), repo: { full_name: "owner/repo" } } }] : []);
    if (relative.startsWith("/pulls/7/commits?")) return Promise.resolve([this.commit(this.human ? "Human change" : "fix: verified repair\n\nAccesswright-Verified-Fix: fixture")]);
    if (relative.startsWith("/compare/")) return Promise.resolve({ status: "ahead", total_commits: 1, merge_base_commit: { sha: base },
      commits: [this.commit(`fix: verified repair\n\nAccesswright-Verified-Fix: ${createHash("sha256").update("fix-1").digest("hex")}`)],
      files: [{ filename: this.extraOrphanFile ? "unverified.ts" : "components/Button.tsx", status: "modified" }] });
    if (relative.startsWith("/git/commits/") && method === "GET") return Promise.resolve({ sha: relative.slice("/git/commits/".length), tree: { sha: "d".repeat(40) } });
    if (relative.startsWith("/git/trees/") && method === "GET") return Promise.resolve({ truncated: false, tree: [...this.files.keys()].map(path => ({ path, mode: "100644", type: "blob" })) });
    if (relative.startsWith("/contents/") && method === "GET") {
      const file = decodeURIComponent(relative.slice("/contents/".length).split("?")[0] ?? "");
      return Promise.resolve({ type: "file", encoding: "base64", content: Buffer.from(this.files.get(file) ?? "").toString("base64") });
    }
    if (relative === "/git/trees" && method === "POST") return Promise.resolve({ sha: "e".repeat(40) });
    if (relative === "/git/commits" && method === "POST") return Promise.resolve({ sha: "f".repeat(40) });
    if (relative === "/git/refs" && method === "POST") return Promise.resolve({});
    if (relative.startsWith("/git/refs/heads/") && method === "PATCH") return Promise.resolve({});
    if (relative === "/pulls" && method === "POST") return Promise.resolve({ number: 8, html_url: "https://github.com/owner/repo/pull/8" });
    if (relative === "/pulls/7" && method === "PATCH") return Promise.resolve({ number: 7, html_url: "https://github.com/owner/repo/pull/7" });
    return Promise.reject(new Error(`Unexpected fixture request: ${method} ${relative}`));
  };
}

describe("verified GitHub publication boundary", () => {
  it("requires a passed final gate before making any GitHub request", async () => {
    const api = new FixtureApi();
    await expect(publishVerifiedPullRequest(api.request, { ...input, verification: { ...input.verification, failures: ["build-error"] } })).rejects.toThrow();
    expect(api.calls).toEqual([]);
  });
  it("rejects a group not accepted by the per-patch verifier", async () => {
    const api = new FixtureApi();
    await expect(publishVerifiedPullRequest(api.request, { ...input, groups: input.groups.map(group => ({ ...group, perPatchAccepted: false })) })).rejects.toThrow();
    expect(api.calls).toEqual([]);
  });
  it("creates a source-only commit and a deterministic review branch without force", async () => {
    const api = new FixtureApi();
    const result = await publishVerifiedPullRequest(api.request, input);
    expect(result).toMatchObject({ status: "created", number: 8, commits: ["f".repeat(40)] });
    const tree = api.calls.find(call => call.method === "POST" && call.path.endsWith("/git/trees"));
    expect(tree?.body).toMatchObject({ tree: [{ path: "components/Button.tsx", content: "after\n", mode: "100644", type: "blob" }] });
    expect(api.calls.find(call => call.path.endsWith("/git/refs"))?.body).toEqual({ ref: `refs/heads/${fixBranchName("main")}`, sha: "f".repeat(40) });
    expect(api.calls.some(call => call.body?.force === true)).toBe(false);
  });
  it("does not create duplicate commits or PRs when the final source is already present", async () => {
    const api = new FixtureApi(); api.existing = true; api.branchHead = existingHead; api.files.set("components/Button.tsx", "after\n");
    expect(await publishVerifiedPullRequest(api.request, input)).toMatchObject({ status: "unchanged", number: 7, commits: [] });
    expect(api.writes).toBe(0);
  });
  it("recovers an exactly verified owned branch after PR creation failed without creating duplicate commits", async () => {
    const api = new FixtureApi(); api.branchHead = existingHead; api.files.set("components/Button.tsx", "after\n");
    const result = await publishVerifiedPullRequest(api.request, input);
    expect(result).toMatchObject({ status: "created", number: 8, commits: [] });
    expect(api.calls.filter(call => call.method !== "GET").map(call => call.path)).toEqual(["/repos/owner/repo/pulls"]);
  });
  it("recovers a GitHub-signed bot orphan and recognizes its existing PR without duplicate writes", async () => {
    const api = new FixtureApi(); api.webFlow = true; api.verification = { verified: true, reason: "valid" };
    api.branchHead = existingHead; api.files.set("components/Button.tsx", "after\n");
    expect(await publishVerifiedPullRequest(api.request, input)).toMatchObject({ status: "created", commits: [] });
    expect(api.calls.filter(call => call.method !== "GET").map(call => call.path)).toEqual(["/repos/owner/repo/pulls"]);
    const existing = new FixtureApi(); existing.webFlow = true; existing.verification = { verified: true, reason: "valid" };
    existing.existing = true; existing.branchHead = existingHead; existing.files.set("components/Button.tsx", "after\n");
    expect(await publishVerifiedPullRequest(existing.request, input)).toMatchObject({ status: "unchanged", commits: [] });
    expect(existing.writes).toBe(0);
  });
  it.each([
    { author: "human", verification: { verified: true, reason: "valid" } },
    { author: null, verification: { verified: true, reason: "valid" } },
    { author: "github-actions[bot]", verification: undefined },
    { author: "github-actions[bot]", verification: { verified: false, reason: "valid" } },
    { author: "github-actions[bot]", verification: { verified: true, reason: "unknown_key" } },
  ])("preserves web-flow commits with unmatched authors or unverified signatures: $author/$verification", async ({ author, verification }) => {
    for (const existing of [false, true]) {
      const api = new FixtureApi(); api.webFlow = true; api.authorLogin = author; api.verification = verification;
      api.existing = existing; api.branchHead = existingHead; api.files.set("components/Button.tsx", "after\n");
      if (existing) expect(await publishVerifiedPullRequest(api.request, input)).toMatchObject({ status: "preserved-human" });
      else await expect(publishVerifiedPullRequest(api.request, input)).rejects.toThrow(/unowned|preserved/);
      expect(api.writes).toBe(0);
    }
  });
  it("does not adopt an orphan branch with a human commit or extra unverified file", async () => {
    const human = new FixtureApi(); human.branchHead = existingHead; human.human = true;
    await expect(publishVerifiedPullRequest(human.request, input)).rejects.toThrow(/unowned|unverified|preserved/i);
    expect(human.writes).toBe(0);
    const extra = new FixtureApi(); extra.branchHead = existingHead; extra.extraOrphanFile = true;
    await expect(publishVerifiedPullRequest(extra.request, input)).rejects.toThrow(/unowned|unverified|preserved/i);
    expect(extra.writes).toBe(0);
  });
  it("rechecks the lease and exact final source before recovering a missing PR", async () => {
    const race = new FixtureApi(); race.branchHead = existingHead; race.race = true; race.files.set("components/Button.tsx", "after\n");
    await expect(publishVerifiedPullRequest(race.request, input)).rejects.toThrow(/changed|concurrent/i);
    expect(race.writes).toBe(0);
    const mismatch = new FixtureApi(); mismatch.branchHead = existingHead;
    await expect(publishVerifiedPullRequest(mismatch.request, input)).rejects.toThrow(/source|verified/i);
    expect(mismatch.writes).toBe(0);
  });
  it("preserves any human commit and does not rewrite its PR body", async () => {
    const api = new FixtureApi(); api.existing = true; api.branchHead = existingHead; api.human = true;
    expect(await publishVerifiedPullRequest(api.request, input)).toMatchObject({ status: "preserved-human", number: 7 });
    expect(api.writes).toBe(0);
  });
  it("rejects a stale verification base and conflicting source before any write", async () => {
    const api = new FixtureApi(); api.currentBase = "c".repeat(40);
    await expect(publishVerifiedPullRequest(api.request, input)).rejects.toThrow(/base|changed/i);
    expect(api.writes).toBe(0);
    const conflict = new FixtureApi(); conflict.files.set("components/Button.tsx", "Human edit\n");
    await expect(publishVerifiedPullRequest(conflict.request, input)).rejects.toThrow(/source|changed/i);
    expect(conflict.writes).toBe(0);
  });
  it("rechecks the branch lease before updating and never overwrites a concurrent commit", async () => {
    const api = new FixtureApi(); api.existing = true; api.branchHead = existingHead; api.race = true;
    await expect(publishVerifiedPullRequest(api.request, input)).rejects.toThrow(/branch|changed/i);
    expect(api.calls.some(call => call.method === "PATCH" && call.path.includes("/git/refs/"))).toBe(false);
  });
  it.each(["../escape.ts", ".github/workflows/run.ts", "docs/internal.ts", "AGENTS.md", "next.config.ts", ".env", "node_modules/pkg/index.ts"])("rejects non-source or internal changes to %s", async path => {
    const api = new FixtureApi();
    const groups = input.groups.map(group => ({ ...group, changes: [{ path, before: "before", after: "after" }] }));
    await expect(publishVerifiedPullRequest(api.request, { ...input, groups })).rejects.toThrow();
    expect(api.calls).toEqual([]);
  });
  it("keeps the token in request headers, disables redirects, and redacts API errors", async () => {
    const seen: Array<{ url: string; options: RequestInit | undefined }> = [];
    const fetcher: typeof fetch = (url, options) => { seen.push({ url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url, options }); return Promise.resolve(new Response('{"message":"private fixture details"}', { status: 403 })); };
    const request = createGitHubRequest("fixture-only", fetcher);
    await expect(request("GET", "/repos/owner/repo/git/ref/heads/main")).rejects.toThrow("GitHub GET failed with HTTP 403");
    expect(seen[0]?.url).toBe("https://api.github.com/repos/owner/repo/git/ref/heads/main");
    expect(seen[0]?.options?.redirect).toBe("error");
    expect(new Headers(seen[0]?.options?.headers).get("Authorization")).toBe("Bearer fixture-only");
    await expect(request("GET", "https://evil.example/")).rejects.toThrow();
    expect(seen.length).toBe(1);
  });
});
