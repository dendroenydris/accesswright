import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHostedServiceRuntime } from "../../src/hosted/service-entry.js";
import { FirestoreHostedRunStore } from "../../src/hosted/firestore-run-store.js";
import { hostedReportDigest } from "../../src/hosted/run-workflow.js";
import { createFakeFirestore } from "../helpers/fake-firestore.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";
import { hostedCandidateFixture } from "../helpers/hosted-candidate.js";
import type { QueuedRun } from "../../src/hosted/webhook.js";
import { assertHostedVerifierNetwork } from "../../src/hosted/verifier-network.js";

vi.mock("../../src/hosted/verifier-network.js", () => ({ assertHostedVerifierNetwork: vi.fn() }));

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }), kid = "local-role-key";
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const taskOrigin = "https://candidate-owned.a.run.app", verifierOrigin = "https://verifier.owned.invalid";
const taskEmail = "tasks@accesswright-dev-123.iam.gserviceaccount.com", relayEmail = "relay@accesswright-dev-123.iam.gserviceaccount.com";
const agentOrigin = "https://agent-owned.a.run.app", jobTaskEmail = "jobs@accesswright-dev-123.iam.gserviceaccount.com";
const run = { runId: "1".repeat(32), repository: "owner/repo", installationId: 42,
  event: "issue_comment" as const, pullNumber: 15, createdAt: "2026-10-11T01:00:00.000Z" };
const servers: Server[] = [];
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aw-service-roles-"));
  vi.mocked(assertHostedVerifierNetwork).mockReset().mockRejectedValue(new Error("Fixture network isolation unconfirmed"));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))));
  await rm(root, { recursive: true, force: true });
});
async function listen(server: Server) {
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture port missing");
  return "http://127.0.0.1:" + address.port;
}
function token(aud: string, email: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud, email, email_verified: true,
    sub: "local-account", iat: now, exp: now + 600 })).toString("base64url");
  const body = header + "." + payload;
  return body + "." + sign("RSA-SHA256", Buffer.from(body), keys.privateKey).toString("base64url");
}
const post = (origin: string, path: string, authorization: string, body: object) => fetch(origin + path, {
  method: "POST", headers: { authorization: "Bearer " + authorization, "content-type": "application/json" }, body: JSON.stringify(body),
});
function fixture() {
  const collections = { agentRuns: "agentRuns", reports: "reports", checkoutPins: "pins", cleanup: "cleanup", spending: "spending" };
  const stores = new Map([...Object.values(collections), "dispatch", "webhooks"].map(name => [name, createFakeFirestore(name)]));
  const calls: string[] = [], provider = new FakeLlmProvider([]), queuedRuns: QueuedRun[] = [];
  const privateRows = new Map<string, { body: string; generation: string }>();
  let trustedOrigin: string | undefined;
  const common = { projectId: "accesswright-dev-123", region: "europe-west1", candidateBucket: "private-candidates",
    candidateQueueId: "candidateTasks", candidateTaskOrigin: taskOrigin, verifierOrigin,
    taskServiceAccountEmail: taskEmail, relayServiceAccountEmail: relayEmail, workRoot: root, collections };
  const trusted = { ...common, appId: 7, repositories: [run.repository], model: { provider: "openai", id: "fixture-only" },
    pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, maxInputTokens: 1200, maxOutputTokens: 256,
    maxCostUsdPerRun: 0.02, runtimeRoot: "/fixture/runtime" };
  const agent = { ...trusted, agentOrigin, jobId: "worker", workerContainerName: "accesswright", jobTaskServiceAccountEmail: jobTaskEmail,
    collections: { ...collections, dispatch: "dispatch" } };
  const webhook = { ...common, appId: 7, repositories: [run.repository], installationAllowlist: [42], agentOrigin,
    jobQueueId: "jobs", jobTaskServiceAccountEmail: jobTaskEmail, collections: { ...collections, webhooks: "webhooks" } };
  const fetcher: typeof fetch = async (input, init) => {
    const uri = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
    calls.push(uri.origin + uri.pathname);
    if (uri.origin === "http://metadata.google.internal") {
      expect(new Headers(init?.headers).get("metadata-flavor")).toBe("Google");
      if (uri.pathname.endsWith("/identity")) {
        expect(uri.searchParams.get("audience")).toBe(verifierOrigin);
        return new Response(token(verifierOrigin, relayEmail), { headers: { "Metadata-Flavor": "Google" } });
      }
      return Response.json({ access_token: "local-fixture-identity", expires_in: 3600, token_type: "Bearer" }, { headers: { "Metadata-Flavor": "Google" } });
    }
    if (uri.href === "https://www.googleapis.com/oauth2/v3/certs") {
      return Response.json({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] });
    }
    if (uri.origin === "https://api.github.com") {
      if (uri.pathname === "/app/installations/42") return Response.json({ id: 42, app_id: 7, account: { login: "owner" }, suspended_at: null });
      if (uri.pathname === "/app/installations/42/access_tokens") {
        expect(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown).toEqual({ repositories: ["repo"], permissions: { contents: "read" } });
        return Response.json({ token: "fixture-github-source", permissions: { contents: "read" }, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
      }
      if (uri.pathname === "/installation/repositories") return Response.json({ total_count: 1, repositories: [{ full_name: run.repository, default_branch: "main" }] });
      if (uri.pathname === "/repos/owner/repo/git/ref/pull/15/head") return Response.json({ ref: "refs/pull/15/head", object: { type: "commit", sha: "a".repeat(40) } });
      if (uri.pathname === "/repos/owner/repo/git/ref/heads/main") return Response.json({ ref: "refs/heads/main", object: { type: "commit", sha: "b".repeat(40) } });
      if (uri.pathname === "/repos/owner/repo/collaborators/reviewer/permission") return Response.json({ permission: "write", user: { login: "reviewer" } });
    }
    if (uri.origin === "https://firestore.googleapis.com") {
      const name = uri.pathname.split("/documents/")[1]?.split("/")[0], store = stores.get(name ?? "");
      if (store) return store.fetcher(input, init);
    }
    if (uri.origin === "https://storage.googleapis.com") {
      if (uri.pathname === "/storage/v1/b/private-candidates") return Response.json({ name: "private-candidates", softDeletePolicy: { retentionDurationSeconds: "0" },
        iamConfiguration: { publicAccessPrevention: "enforced", uniformBucketLevelAccess: { enabled: true } } });
      const name = uri.pathname.startsWith("/upload/") ? uri.searchParams.get("name") ?? "" : decodeURIComponent(uri.pathname.split("/o/")[1] ?? "");
      const metadata = (row: { body: string; generation: string }) => ({ bucket: "private-candidates", name, generation: row.generation, size: String(Buffer.byteLength(row.body)) });
      if (init?.method === "POST") {
        expect(uri.searchParams.get("ifGenerationMatch")).toBe("0");
        if (privateRows.has(name)) return new Response(null, { status: 412 });
        if (typeof init.body !== "string") throw new Error("Candidate fixture body missing");
        const row = { body: init.body, generation: "123456789" }; privateRows.set(name, row); return Response.json(metadata(row));
      }
      const row = uri.searchParams.get("softDeleted") === "true" ? undefined : privateRows.get(name);
      if (!row) return new Response(null, { status: 404 });
      if (init?.method === "DELETE") {
        expect(uri.searchParams.get("ifGenerationMatch")).toBe(row.generation); privateRows.delete(name); return new Response(null, { status: 204 });
      }
      if (uri.searchParams.get("alt") === "media") return new Response(row.body);
      return Response.json(metadata(row));
    }
    if (uri.href === "https://cloudtasks.googleapis.com/v2/projects/accesswright-dev-123/locations/europe-west1/queues/candidateTasks/tasks") {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { task: { scheduleTime?: string } };
      return Response.json({ ...body.task, scheduleTime: body.task.scheduleTime ?? new Date().toISOString() });
    }
    if (uri.href === "https://cloudtasks.googleapis.com/v2/projects/accesswright-dev-123/locations/europe-west1/queues/jobs/tasks") {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { task: { httpRequest: { body: string } } };
      queuedRuns.push(JSON.parse(Buffer.from(body.task.httpRequest.body, "base64").toString("utf8")) as QueuedRun);
      return Response.json(body.task);
    }
    if (uri.href === "https://run.googleapis.com/v2/projects/accesswright-dev-123/locations/europe-west1/jobs/worker:run") {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { overrides: { containerOverrides: Array<{ env: Array<{ name: string; value: string }> }> } };
      expect(body.overrides.containerOverrides[0]?.env.find(variable => variable.name === "ACCESSWRIGHT_RUN_TOKEN")?.value).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(body)).not.toContain(privateKey); expect(JSON.stringify(body)).not.toContain("OPENAI_API_KEY");
      return Response.json({ name: "projects/accesswright-dev-123/locations/europe-west1/operations/fixture-operation" });
    }
    if (uri.origin === verifierOrigin && trustedOrigin) {
      expect(uri.pathname).toBe("/internal/candidates/verify");
      return fetch(trustedOrigin + uri.pathname, init);
    }
    throw new Error("Unexpected fixture endpoint");
  };
  const environment = { ACCESSWRIGHT_GITHUB_APP_PRIVATE_KEY: privateKey };
  return { common, trusted, agent, webhook, queuedRuns, privateRows, calls, provider, environment, fetcher, stores, connect: (origin: string) => { trustedOrigin = origin; } };
}

it("creates a keyless relay and a verifier without an LLM key, with no startup network requests", () => {
  const f = fixture();
  const relay = createHostedServiceRuntime({ ...f.common, role: "relay" }, { environment: {}, fetcher: f.fetcher });
  const verifier = createHostedServiceRuntime({ ...f.trusted, role: "verifier" }, { environment: f.environment, fetcher: f.fetcher });
  expect(relay.role).toBe("relay"); expect(verifier.role).toBe("verifier"); expect(f.calls).toHaveLength(0);
  relay.server.close(); verifier.server.close();
});

it("accepts canonical regional Cloud Run origins without making startup requests", () => {
  const f = fixture();
  const candidateTaskOrigin = "https://candidate-123456789012.europe-west1.run.app", agentOrigin = "https://agent-123456789012.europe-west1.run.app";
  const service = createHostedServiceRuntime({ ...f.agent, role: "agent", candidateTaskOrigin, agentOrigin },
    { environment: f.environment, fetcher: f.fetcher, provider: f.provider });
  expect(service.role).toBe("agent"); expect(f.calls).toHaveLength(0); service.server.close();
  expect(() => createHostedServiceRuntime({ ...f.agent, role: "agent", candidateTaskOrigin: candidateTaskOrigin + ".attacker.example", agentOrigin },
    { environment: f.environment, fetcher: f.fetcher, provider: f.provider })).toThrow();
  expect(() => createHostedServiceRuntime({ ...f.agent, role: "agent", candidateTaskOrigin, agentOrigin: agentOrigin + ".attacker.example" },
    { environment: f.environment, fetcher: f.fetcher, provider: f.provider })).toThrow();
  expect(f.calls).toHaveLength(0);
});

it("pins the PR head before worker authorization and only polls scheduled finish", async () => {
  const f = fixture(), service = createHostedServiceRuntime({ ...f.agent, role: "agent" }, { environment: f.environment, fetcher: f.fetcher, provider: f.provider });
  if (!service.registerRunToken) throw new Error("Agent registration missing");
  const auth = await service.registerRunToken(run), origin = await listen(service.server);
  const pin = f.stores.get("pins")?.records.get(run.runId);
  expect(JSON.parse(pin?.payload ?? "{}") as unknown).toMatchObject({ verifiedBaseSha: "a".repeat(40) });
  const submitted = await post(origin, "/runs/" + run.runId + "/results", auth, hostedCandidateFixture().report);
  expect(submitted.status).toBe(202); await submitted.arrayBuffer();
  const finish = await post(origin, "/runs/" + run.runId + "/finish", auth, {});
  expect(finish.status).toBe(202); expect(await finish.json()).toMatchObject({ status: "recorded" });
  expect(f.calls.some(uri => uri.includes("storage.googleapis.com"))).toBe(false); expect(f.provider.requests).toHaveLength(0);
  expect(await readFile(join(root, "evidence", run.runId, "run.jsonl"), "utf8")).not.toContain("fixture-github-source");
});

it("authenticates task-to-relay-to-verifier separately and requires the durable blocked result when no candidate exists", async () => {
  const f = fixture(), agent = createHostedServiceRuntime({ ...f.agent, role: "agent" }, { environment: f.environment, fetcher: f.fetcher, provider: f.provider });
  if (!agent.registerRunToken) throw new Error("Agent registration missing");
  const workerToken = await agent.registerRunToken(run), agentOrigin = await listen(agent.server);
  const report = hostedCandidateFixture().report, submitted = await post(agentOrigin, "/runs/" + run.runId + "/results", workerToken, report);
  expect(submitted.status).toBe(202); await submitted.arrayBuffer();
  const verifier = createHostedServiceRuntime({ ...f.trusted, role: "verifier" }, { environment: f.environment, fetcher: f.fetcher });
  const verifierLocal = await listen(verifier.server); f.connect(verifierLocal);
  const relay = createHostedServiceRuntime({ ...f.common, role: "relay" }, { environment: {}, fetcher: f.fetcher }), relayLocal = await listen(relay.server);
  const body = { runId: run.runId, reportDigest: hostedReportDigest(report) }, path = "/internal/candidates/verify";
  for (const origin of [relayLocal, verifierLocal]) {
    const rejected = await post(origin, path, workerToken, body); expect(rejected.status).toBe(401); await rejected.arrayBuffer();
  }
  const wrongAccount = await post(verifierLocal, path, token(verifierOrigin, taskEmail), body);
  expect(wrongAccount.status).toBe(401); await wrongAccount.arrayBuffer();
  const verified = await post(relayLocal, path, token(taskOrigin, taskEmail), body);
  expect(verified.status).toBe(200); expect(await verified.json()).toEqual({ runId: run.runId, status: "blocked" });
  const reportStore = f.stores.get("reports"); if (!reportStore) throw new Error("Fixture report store missing");
  expect((await new FirestoreHostedRunStore(reportStore.options).get(run.runId))?.status).toBe("blocked");
  expect(f.provider.requests).toHaveLength(0);
  const repeat = await post(relayLocal, path, token(taskOrigin, taskEmail), body);
  expect(repeat.status).toBe(200); await repeat.arrayBuffer();
  expect(f.calls.filter(uri => uri.includes("storage.googleapis.com"))).toHaveLength(1);
});

it("rejects missing agent keys, collection aliasing, shared identities and extra configuration before network access", () => {
  const f = fixture();
  expect(() => createHostedServiceRuntime({ ...f.agent, role: "agent" }, { environment: f.environment, fetcher: f.fetcher })).toThrow();
  expect(() => createHostedServiceRuntime({ ...f.common, role: "relay", collections: { ...f.common.collections, cleanup: "reports" } }, { fetcher: f.fetcher })).toThrow("distinct");
  expect(() => createHostedServiceRuntime({ ...f.common, role: "relay", relayServiceAccountEmail: taskEmail }, { fetcher: f.fetcher })).toThrow("distinct");
  expect(() => createHostedServiceRuntime({ ...f.common, role: "relay", providerKey: "forbidden" }, { fetcher: f.fetcher })).toThrow();
  expect(f.calls).toHaveLength(0);
});

it("withholds a trusted receipt and clears staged source when the verifier network guard fails before GitHub credentials", async () => {
  const f = fixture(), agent = createHostedServiceRuntime({ ...f.agent, role: "agent" }, { environment: f.environment, fetcher: f.fetcher, provider: f.provider });
  if (!agent.registerRunToken) throw new Error("Agent registration missing");
  const workerToken = await agent.registerRunToken(run), origin = await listen(agent.server), candidate = hostedCandidateFixture();
  const staged = await post(origin, "/runs/" + run.runId + "/candidate", workerToken, candidate);
  expect(staged.status).toBe(202); await staged.arrayBuffer(); expect(f.privateRows.size).toBe(1);
  const githubCalls = f.calls.filter(uri => uri.startsWith("https://api.github.com")).length;
  const verifier = createHostedServiceRuntime({ ...f.trusted, role: "verifier" }, { environment: f.environment, fetcher: f.fetcher, provider: f.provider });
  const response = await post(await listen(verifier.server), "/internal/candidates/verify", token(verifierOrigin, relayEmail),
    { runId: run.runId, reportDigest: hostedReportDigest(candidate.report) });
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ status: "requires-reconciliation" });
  expect(assertHostedVerifierNetwork).toHaveBeenCalledOnce();
  expect(f.calls.filter(uri => uri.startsWith("https://api.github.com"))).toHaveLength(githubCalls);
  expect(f.privateRows.size).toBe(0); expect(f.provider.requests).toHaveLength(0);
  const reportStore = f.stores.get("reports"); if (!reportStore) throw new Error("Fixture report store missing");
  expect(await new FirestoreHostedRunStore(reportStore.options).get(run.runId)).toMatchObject({ status: "verifying", verifiedBaseSha: null });
  const record = await readFile(join(root, "evidence", run.runId, "run.jsonl"), "utf8");
  expect(record).toContain('"step":"hosted-verifier-network-isolation","status":"error"');
  expect(record).toContain("hosted-candidate-cleared"); expect(record).not.toContain("fixture-github-source");
});

it("launches one pinned worker through authenticated job dispatch and survives an agent service restart", async () => {
  const f = fixture(), open = () => createHostedServiceRuntime({ ...f.agent, role: "agent" }, { environment: f.environment, fetcher: f.fetcher, provider: f.provider });
  const first = await listen(open().server);
  const worker = await post(first, "/internal/jobs", "a".repeat(64), run);
  expect(worker.status).toBe(401); await worker.arrayBuffer(); expect(f.calls).toHaveLength(0);
  const launched = await post(first, "/internal/jobs", token(agentOrigin, jobTaskEmail), run);
  expect(launched.status).toBe(202); expect(await launched.json()).toEqual({ runId: run.runId, status: "launched" });
  const restarted = await listen(open().server), duplicate = await post(restarted, "/internal/jobs", token(agentOrigin, jobTaskEmail), run);
  expect(duplicate.status).toBe(200); expect(await duplicate.json()).toEqual({ runId: run.runId, status: "duplicate" });
  expect(f.calls.filter(uri => uri.endsWith("jobs/worker:run"))).toHaveLength(1); expect(f.provider.requests).toHaveLength(0);
  const claim = f.stores.get("dispatch")?.records.get(run.runId);
  expect(JSON.parse(claim?.payload ?? "{}") as unknown).toMatchObject({ status: "launched", operation: "projects/accesswright-dev-123/locations/europe-west1/operations/fixture-operation" });
  expect(claim?.payload).not.toContain("token");
});

it("composes signed multi-repository webhooks with durable task enqueue and authenticated agent dispatch, without model keys", async () => {
  const f = fixture(), secret = "local-webhook-only-secret";
  const open = () => createHostedServiceRuntime({ ...f.webhook, role: "webhook" }, { environment: { ...f.environment, ACCESSWRIGHT_GITHUB_WEBHOOK_SECRET: secret }, fetcher: f.fetcher });
  const origin = await listen(open().server);
  const body = JSON.stringify({ action: "created", installation: { id: 42 }, sender: { login: "owner" },
    repositories: [{ full_name: "owner/repo", private: true }, { full_name: "owner/not-allowlisted", private: true }] });
  const headers = { "content-type": "application/json", "x-github-event": "installation", "x-github-delivery": "11111111-1111-4111-8111-111111111111",
    "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex") };
  const accepted = await fetch(origin + "/github/webhook", { method: "POST", headers, body });
  expect(accepted.status).toBe(202); await accepted.arrayBuffer(); expect(f.queuedRuns).toHaveLength(1);
  const restarted = await listen(open().server), repeat = await fetch(restarted + "/github/webhook", { method: "POST", headers, body });
  expect(repeat.status).toBe(200); expect(await repeat.json()).toMatchObject({ status: "duplicate" }); expect(f.queuedRuns).toHaveLength(1);
  const queued = f.queuedRuns[0]; if (!queued) throw new Error("Fixture task missing");
  const agent = createHostedServiceRuntime({ ...f.agent, role: "agent" }, { environment: f.environment, fetcher: f.fetcher, provider: f.provider });
  const started = await post(await listen(agent.server), "/internal/jobs", token(agentOrigin, jobTaskEmail), queued);
  expect(started.status).toBe(202); await started.arrayBuffer();
  const pin = f.stores.get("pins")?.records.get(queued.runId);
  expect(JSON.parse(pin?.payload ?? "{}") as unknown).toMatchObject({ verifiedBaseSha: "b".repeat(40) });
  expect(f.provider.requests).toHaveLength(0);
  const record = await readFile(join(root, "evidence", queued.runId, "run.jsonl"), "utf8");
  expect(record).toContain("hosted-webhook-enqueued"); expect(record).not.toContain(secret); expect(record).not.toContain(privateKey);
});
