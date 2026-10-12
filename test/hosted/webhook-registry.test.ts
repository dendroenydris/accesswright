import { createHash, createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { FirestoreWebhookRunRegistry } from "../../src/hosted/webhook-registry.js";
import { dispatchGitHubWebhook } from "../../src/hosted/webhook.js";
import { createFakeFirestore } from "../helpers/fake-firestore.js";

const secret = "local-webhook-fixture";
const repository = { full_name: "owner/repo", private: true };
const key = "installation|42|owner/repo", digest = createHash("sha256").update(key).digest("hex");
function signed(delivery = "11111111-1111-4111-8111-111111111111", repositories = [repository]) {
  const body = Buffer.from(JSON.stringify({ action: "created", installation: { id: 42 }, sender: { login: "owner" },
    repositories, privateText: "must-never-be-retained" }));
  return { body, headers: { "x-github-delivery": delivery, "x-github-event": "installation",
    "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex") } };
}

it("persists one independent enqueue per repository and confirms duplicates after restart", async () => {
  const cloud = createFakeFirestore("webhooks"), queued: string[] = [], input = signed(undefined, [repository, { full_name: "owner/second", private: false }]);
  const open = () => ({ secret, installationAllowlist: new Set([42]), repositoryAllowlist: new Set([repository.full_name, "owner/second"]), registry: new FirestoreWebhookRunRegistry(cloud.options),
    queue: (run: { repository: string }) => { queued.push(run.repository); return Promise.resolve(); }, authorizeComment: () => Promise.resolve(false) });
  const first = await dispatchGitHubWebhook(input.body, input.headers, open());
  expect(first.status).toBe("queued"); expect(first.runIds).toHaveLength(2); expect(cloud.records.size).toBe(2);
  const repeat = signed("22222222-2222-4222-8222-222222222222", [repository, { full_name: "owner/second", private: false }]);
  expect(await dispatchGitHubWebhook(repeat.body, repeat.headers, open())).toEqual({ status: "duplicate", runIds: first.runIds });
  expect(queued).toEqual(["owner/repo", "owner/second"]);
  expect([...cloud.records.values()].every(row => !row.payload.includes("must-never-be-retained"))).toBe(true);
});

it("retains an uncertain queue attempt across restarts and never starts a second attempt", async () => {
  const cloud = createFakeFirestore("webhooks"), input = signed();
  let attempts = 0;
  const open = () => ({ secret, installationAllowlist: new Set([42]), repositoryAllowlist: new Set([repository.full_name]), registry: new FirestoreWebhookRunRegistry(cloud.options),
    queue: () => { attempts += 1; return Promise.reject(new Error("Queue acknowledgement was lost")); }, authorizeComment: () => Promise.resolve(false) });
  await expect(dispatchGitHubWebhook(input.body, input.headers, open())).rejects.toThrow("acknowledgement");
  expect(JSON.parse(cloud.records.get(digest)?.payload ?? "{}") as unknown).toMatchObject({ status: "requires-reconciliation", run: null });
  await expect(dispatchGitHubWebhook(input.body, input.headers, open())).rejects.toThrow("reconciliation");
  expect(attempts).toBe(1);
});

it("withholds duplicates while the original queue operation is in progress", async () => {
  const cloud = createFakeFirestore("webhooks"), input = signed();
  let finish = () => {};
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let started = () => {};
  const queueStarted = new Promise<void>(resolve => { started = resolve; });
  const first = dispatchGitHubWebhook(input.body, input.headers, { secret, installationAllowlist: new Set([42]), repositoryAllowlist: new Set([repository.full_name]),
    registry: new FirestoreWebhookRunRegistry(cloud.options), queue: () => { started(); return pending; }, authorizeComment: () => Promise.resolve(false) });
  await queueStarted;
  const retry = dispatchGitHubWebhook(input.body, input.headers, { secret, installationAllowlist: new Set([42]), repositoryAllowlist: new Set([repository.full_name]),
    registry: new FirestoreWebhookRunRegistry(cloud.options), queue: () => Promise.reject(new Error("Duplicate enqueue")), authorizeComment: () => Promise.resolve(false) });
  await expect(retry).rejects.toThrow("reconciliation");
  finish(); expect((await first).status).toBe("queued");
});

it("preserves a confirmed enqueue if the commit response is lost after storage", async () => {
  const cloud = createFakeFirestore("webhooks"), input = signed();
  let fail = true, queued = 0;
  const fetcher: typeof fetch = async (uri, init) => {
    const response = await cloud.fetcher(uri, init);
    if (init?.method === "PATCH" && fail) { fail = false; throw new Error("Commit response lost"); }
    return response;
  };
  const open = () => ({ secret, installationAllowlist: new Set([42]), repositoryAllowlist: new Set([repository.full_name]), registry: new FirestoreWebhookRunRegistry({ ...cloud.options, fetcher }),
    queue: () => { queued += 1; return Promise.resolve(); }, authorizeComment: () => Promise.resolve(false) });
  await expect(dispatchGitHubWebhook(input.body, input.headers, open())).rejects.toThrow("Commit response lost");
  expect((await dispatchGitHubWebhook(input.body, input.headers, open())).status).toBe("duplicate"); expect(queued).toBe(1);
});

it("rejects corrupted completed identities and cannot commit a different run", async () => {
  const cloud = createFakeFirestore("webhooks"), registry = new FirestoreWebhookRunRegistry(cloud.options), delivery = "d".repeat(64);
  expect(await registry.claim(key, delivery)).toBe(true);
  const run = { runId: "0".repeat(32), repository: repository.full_name, installationId: 42,
    event: "installation" as const, createdAt: "2026-10-11T01:00:00.000Z", pullNumber: null };
  await expect(registry.commit(key, run)).rejects.toThrow("identity changed");
  cloud.records.set(digest, { rev: 2, payload: JSON.stringify({ runId: digest, delivery, status: "queued", run }) });
  await expect(new FirestoreWebhookRunRegistry(cloud.options).claim(key, delivery)).rejects.toThrow("reconciliation");
});
