import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import {
  InMemoryRunRegistry,
  dispatchGitHubWebhook,
  verifyGitHubSignature,
} from "../../src/hosted/webhook.js";

const secret = "fixture-only-webhook-secret";
function signed(payload: unknown, event: string, delivery: string) {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return { body, headers: { "x-hub-signature-256": signature, "x-github-event": event, "x-github-delivery": delivery } };
}
const installation = { id: 42 };
const repository = { full_name: "owner/private-app", private: true };
const base = { installation, repository, sender: { login: "trusted-reviewer" } };

it("authenticates exact raw bytes, refuses missing/wrong signature and oversized bodies", () => {
  const input = signed(base, "installation", "11111111-1111-4111-8111-111111111111");
  expect(verifyGitHubSignature(input.body, input.headers["x-hub-signature-256"], secret)).toBe(true);
  expect(verifyGitHubSignature(input.body, "", secret)).toBe(false);
  expect(verifyGitHubSignature(Buffer.from("{}"), input.headers["x-hub-signature-256"], secret)).toBe(false);
  expect(() => verifyGitHubSignature(Buffer.alloc(1_048_577), input.headers["x-hub-signature-256"], secret)).toThrow(/size/i);
});

it("queues only authorized installation and comment events with delivery/run idempotence", async () => {
  const registry = new InMemoryRunRegistry();
  const enqueued: string[] = [];
  const dependencies = {
    secret,
    installationAllowlist: new Set([42]),
    registry,
    queue: (job: { runId: string }) => { enqueued.push(job.runId); return Promise.resolve(); },
    authorizeComment: () => Promise.resolve(true),
  };
  const first = signed({ ...base, action: "created" }, "installation", "11111111-1111-4111-8111-111111111111");
  const queued = await dispatchGitHubWebhook(first.body, first.headers, dependencies);
  expect(queued).toMatchObject({ status: "queued" });
  const again = await dispatchGitHubWebhook(first.body, first.headers, dependencies);
  expect(again).toMatchObject({ status: "duplicate" });
  const comment = signed({
    ...base,
    action: "created",
    issue: { number: 10, pull_request: { url: "https://api.github.com/repos/owner/private-app/pulls/10" } },
    comment: { body: "/accesswright fix", id: 5 },
  }, "issue_comment", "22222222-2222-4222-8222-222222222222");
  expect(await dispatchGitHubWebhook(comment.body, comment.headers, dependencies)).toMatchObject({ status: "queued" });
  const differentDeliverySameComment = signed({
    ...base,
    action: "created",
    issue: { number: 10, pull_request: { url: "https://api.github.com/repos/owner/private-app/pulls/10" } },
    comment: { body: "/accesswright fix", id: 5 },
  }, "issue_comment", "33333333-3333-4333-8333-333333333333");
  expect(await dispatchGitHubWebhook(differentDeliverySameComment.body, differentDeliverySameComment.headers, dependencies)).toMatchObject({ status: "duplicate" });
  expect(enqueued).toHaveLength(2);
  expect(registry.list().every(row => !JSON.stringify(row).includes("/accesswright fix"))).toBe(true);
});

it("does not queue unallowlisted or unauthorized comments, unsafe event types, or ordinary push", async () => {
  const registry = new InMemoryRunRegistry();
  const calls: string[] = [];
  const dependencies = {
    secret, installationAllowlist: new Set([42]), registry,
    queue: () => { calls.push("queued"); return Promise.resolve(); },
    authorizeComment: () => Promise.resolve(false),
  };
  const push = signed({ ...base, action: "synchronize" }, "push", "44444444-4444-4444-8444-444444444444");
  expect(await dispatchGitHubWebhook(push.body, push.headers, dependencies)).toMatchObject({ status: "ignored" });
  const comment = signed({ ...base, action: "created", issue: { number: 1, pull_request: {} }, comment: { body: "/accesswright fix", id: 99 } }, "issue_comment", "55555555-5555-4555-8555-555555555555");
  expect(await dispatchGitHubWebhook(comment.body, comment.headers, dependencies)).toMatchObject({ status: "unauthorized" });
  const other = signed({ ...base, installation: { id: 404 }, action: "created" }, "installation", "66666666-6666-4666-8666-666666666666");
  expect(await dispatchGitHubWebhook(other.body, other.headers, dependencies)).toMatchObject({ status: "unauthorized" });
  expect(calls).toEqual([]);
});

it("does not mark failed enqueue as successful and allows the same delivery to retry", async () => {
  const registry = new InMemoryRunRegistry();
  const input = signed({ ...base, action: "created" }, "installation", "77777777-7777-4777-8777-777777777777");
  let attempts = 0;
  const dependencies = {
    secret, installationAllowlist: new Set([42]), registry,
    queue: () => { attempts += 1; return attempts === 1 ? Promise.reject(new Error("transient queue failure")) : Promise.resolve(); },
    authorizeComment: () => Promise.resolve(true),
  };
  await expect(dispatchGitHubWebhook(input.body, input.headers, dependencies)).rejects.toThrow(/queue/i);
  expect(registry.list()).toEqual([]);
  expect(await dispatchGitHubWebhook(input.body, input.headers, dependencies)).toMatchObject({ status: "queued" });
  expect(attempts).toBe(2);
});
