import { expect, it } from "vitest";

import {
  publishVerifiedPullRequestSuggestions,
} from "../../src/reporter/pr-mode-publisher.js";
import type { GitHubRequest, PublishInput } from "../../src/reporter/github-publisher.js";

const head = "a".repeat(40);
const groups: PublishInput["groups"] = [{
  id: "fix-button",
  ruleId: "button-name",
  criterion: "4.1.2",
  perPatchAccepted: true,
  changes: [{
    path: "components/Button.tsx",
    before: [
      "export function Button() {",
      "  return (",
      '    <button aria-label="">Save</button>',
      "  );",
      "}",
      "",
    ].join("\n"),
    after: [
      "export function Button() {",
      "  return (",
      '    <button aria-label="Save">Save</button>',
      "  );",
      "}",
      "",
    ].join("\n"),
  }],
}];

class Api {
  calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  head = head;
  request: GitHubRequest = (method, path, body) => {
    this.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (method === "GET" && path === "/repos/owner/repo/pulls/7") {
      return Promise.resolve({ head: { sha: this.head } });
    }
    if (method === "GET" && path === "/repos/owner/repo/pulls/7/files?per_page=100&page=1") {
      return Promise.resolve([{
        filename: "components/Button.tsx",
        status: "modified",
        patch: [
          "@@ -1,5 +1,5 @@",
          " export function Button() {",
          "   return (",
          '-    <button aria-label="">Save</button>',
          '+    <button aria-label="Draft">Save</button>',
          "   );",
          " }",
        ].join("\n"),
      }]);
    }
    if (method === "POST" && path === "/repos/owner/repo/pulls/7/reviews") {
      return Promise.resolve({ id: 9 });
    }
    if (method === "POST" && path === "/repos/owner/repo/issues/7/comments") {
      return Promise.resolve({ id: 10 });
    }
    return Promise.reject(new Error("Unexpected request: " + method + " " + path));
  };
}

it("publishes verified in-diff fixes as anchored GitHub suggestions after a head lease recheck", async () => {
  const api = new Api();
  const result = await publishVerifiedPullRequestSuggestions(api.request, {
    repository: "owner/repo",
    pullNumber: 7,
    verifiedHeadSha: head,
    groups,
  });
  expect(result).toMatchObject({ status: "published", suggestions: 1, handoffs: 0 });
  const write = api.calls.find(call => call.method === "POST");
  expect(write?.path).toBe("/repos/owner/repo/pulls/7/reviews");
  expect(write?.body).toMatchObject({
    commit_id: head,
    event: "COMMENT",
    comments: [{
      path: "components/Button.tsx",
      line: 3,
      side: "RIGHT",
    }],
  });
  const comments = write?.body?.comments as Array<{ body: string }> | undefined;
  expect(comments?.[0]?.body).toBe([
    String.fromCharCode(96).repeat(3) + "suggestion",
    '    <button aria-label="Save">Save</button>',
    String.fromCharCode(96).repeat(3),
  ].join("\n"));
  expect(api.calls.filter(call => call.path === "/repos/owner/repo/pulls/7")).toHaveLength(2);
});

it("posts only a bounded CLI handoff comment when the verified fix is outside the PR diff", async () => {
  const api = new Api();
  api.request = (method, path, body) => {
    api.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (method === "GET" && path === "/repos/owner/repo/pulls/7") return Promise.resolve({ head: { sha: head } });
    if (method === "GET" && path.includes("/files?")) {
      return Promise.resolve([{ filename: "components/Button.tsx", status: "modified", patch: "@@ -1,1 +1,1 @@\n-old\n+new" }]);
    }
    if (method === "POST" && path === "/repos/owner/repo/issues/7/comments") return Promise.resolve({ id: 10 });
    return Promise.reject(new Error("Unexpected request: " + method + " " + path));
  };
  const result = await publishVerifiedPullRequestSuggestions(api.request, {
    repository: "owner/repo",
    pullNumber: 7,
    verifiedHeadSha: head,
    groups,
  });
  expect(result).toMatchObject({ status: "handoff", suggestions: 0, handoffs: 1 });
  const write = api.calls.find(call => call.method === "POST");
  expect(write?.body?.body).toContain("components/Button.tsx");
  expect(write?.body?.body).not.toContain(groups[0]?.changes[0]?.before ?? "impossible");
});

it("fails before any write when the PR head changed after verification", async () => {
  const api = new Api();
  api.head = "b".repeat(40);
  await expect(publishVerifiedPullRequestSuggestions(api.request, {
    repository: "owner/repo",
    pullNumber: 7,
    verifiedHeadSha: head,
    groups,
  })).rejects.toThrow(/head/i);
  expect(api.calls.every(call => call.method === "GET")).toBe(true);
});
