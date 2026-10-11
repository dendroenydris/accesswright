import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { defaults } from "../../src/config.js";
import { HostedAgentClient } from "../../src/hosted/agent-client.js";
import type { FixTask } from "../../src/types/schemas.js";
import { hostedCandidateDigest } from "../../src/hosted/agent-protocol.js";
import { hostedCandidateFixture } from "../helpers/hosted-candidate.js";

const task: FixTask = { id: "button-name:save", ruleId: "button-name", criterion: "4.1.2", kind: "semantic", route: "llm",
  source: { file: "Button.tsx", line: 1, column: 1 }, routes: ["/"],
  violations: [{ ruleId: "button-name", impact: "serious", route: "/", target: ["#save"], html: "<button/>", failureSummary: null, source: { file: "Button.tsx", line: 1, column: 1 } }] };
const context = { component: { ...task.source!, sourceExcerpt: '<button id="save" />' }, callSites: [],
  page: { title: "Settings", surroundingText: "Save changes", caption: null, linkTarget: null }, screenshotPath: null };
const accepted = { status: "accepted", patch: { taskId: task.id, changes: [{ path: "Button.tsx", before: '<button id="save" />', after: '<button id="save" aria-label="Save changes" />' }] }, usage: { inputTokens: 300, outputTokens: 100, costUsd: 0.0005 } };
const options = { origin: "https://agent.example", runId: "run-1", token: "a".repeat(64) };

it("sends only the scoped authorization header and validates a patch response without following redirects", async () => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(accepted)));
  const client = new HostedAgentClient({ ...options, fetcher });
  expect(await client.patch(task, context)).toEqual(accepted);
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe("https://agent.example/runs/run-1/tasks/button-name%3Asave/patch");
  expect(url).not.toContain(options.token);
  expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store", headers: { authorization: "Bearer " + options.token } });
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  if (typeof init?.body !== "string") throw new Error("Missing serialized request body");
  expect(JSON.parse(init.body)).toMatchObject({ task, context, images: [], feedback: null });
});

it.each(["http://agent.example", "https://user:password@agent.example", "https://agent.example/path", "https://agent.example/?token=secret", "https://agent.example/#secret", "file:///tmp/agent"])("rejects unsafe agent origin %s before sending source or authorization", origin => {
  expect(() => new HostedAgentClient({ ...options, origin })).toThrow(/origin/);
});

it.each(["http://127.0.0.1:1234", "http://[::1]:1234", "http://localhost:1234"])("allows owned loopback origin %s", origin => {
  expect(() => new HostedAgentClient({ ...options, origin })).not.toThrow();
});

it.each(["task", "path", "manifest", "usage", "extra", "status"])("rejects contradictory %s response without returning untrusted source", async kind => {
  const body = structuredClone(accepted);
  if (kind === "task") body.patch.taskId = "unrelated";
  if (kind === "path") body.patch.changes[0].path = "private.tsx";
  if (kind === "manifest") body.patch.changes[0].path = "package.json";
  if (kind === "usage") body.usage.inputTokens = -1;
  const input = kind === "extra" ? { ...body, credential: "must-not-echo" } : body;
  const fetcher: typeof fetch = () => Promise.resolve(Response.json(input, { status: kind === "status" ? 422 : 200 }));
  expect(await new HostedAgentClient({ ...options, fetcher }).patch(task, context)).toMatchObject({ status: "rejected", usage: null });
});

it("retains known rejected-attempt usage and never retries an interrupted response", async () => {
  const rejected = { status: "rejected", reason: "patch-validation-failed", usage: accepted.usage };
  const known: typeof fetch = () => Promise.resolve(Response.json(rejected, { status: 422 }));
  expect(await new HostedAgentClient({ ...options, fetcher: known }).patch(task, context)).toEqual(rejected);
  const interrupted = vi.fn<typeof fetch>(() => Promise.reject(new Error("private-source-and-token")));
  const response = await new HostedAgentClient({ ...options, fetcher: interrupted }).patch(task, context);
  expect(response).toEqual({ status: "rejected", reason: "agent-response-unreconciled", usage: null });
  expect(JSON.stringify(response)).not.toContain("private-source-and-token");
  expect(interrupted).toHaveBeenCalledTimes(1);
});

it.each(["header", "stream", "json", "http"])("bounds and rejects %s transport failures", async kind => {
  const response = kind === "header" ? new Response("private", { headers: { "content-length": String(defaults.hostedMaxPatchResponseBytes + 1) } })
    : kind === "stream" ? new Response("x".repeat(defaults.hostedMaxPatchResponseBytes + 1))
      : kind === "json" ? new Response("<script>private-source</script>") : Response.json({ status: "redirect" }, { status: 302 });
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(response));
  expect(await new HostedAgentClient({ ...options, fetcher }).patch(task, context)).toMatchObject({ status: "rejected", usage: null });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(response.body?.locked).toBe(false);
});

it("refuses malformed images and feedback before making a request", async () => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(accepted)));
  const client = new HostedAgentClient({ ...options, fetcher });
  await expect(client.patch(task, context, [{ data: new Uint8Array([1, 2, 3]), mediaType: "image/png" }])).rejects.toThrow();
  await expect(client.patch(task, context, [], "x".repeat(defaults.hostedMaxFeedbackChars + 1))).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it("sends one private candidate and requires an acknowledgment of its exact digest", async () => {
  const candidate = hostedCandidateFixture();
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ status: "recorded", runId: options.runId, candidateDigest: hostedCandidateDigest(candidate) }, { status: 202 })));
  await new HostedAgentClient({ ...options, fetcher }).submitCandidate(candidate);
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe("https://agent.example/runs/run-1/candidate");
  expect(init).toMatchObject({ redirect: "error", credentials: "omit", headers: { authorization: "Bearer " + options.token } });
  expect(init?.body).toBe(JSON.stringify(candidate));
});

it.each(["run", "digest", "status", "header", "stream", "json", "lost"])("rejects an unconfirmed %s candidate transfer without retry or source disclosure", async kind => {
  const candidate = hostedCandidateFixture();
  const ack = { status: "recorded", runId: options.runId, candidateDigest: hostedCandidateDigest(candidate) };
  if (kind === "run") ack.runId = "other-run";
  if (kind === "digest") ack.candidateDigest = "0".repeat(64);
  if (kind === "status") ack.status = "ready-for-review";
  const fetcher = vi.fn<typeof fetch>(() => kind === "lost" ? Promise.reject(new Error("private-source-marker " + options.token)) : Promise.resolve(
    kind === "header" ? new Response("private-source-marker", { status: 202, headers: { "content-length": String(defaults.hostedMaxCandidateResponseBytes + 1) } }) :
      kind === "stream" ? new Response("x".repeat(defaults.hostedMaxCandidateResponseBytes + 1), { status: 202 }) :
        kind === "json" ? new Response("private-source-marker", { status: 202 }) : Response.json(ack, { status: 202 })));
  await expect(new HostedAgentClient({ ...options, fetcher }).submitCandidate(candidate)).rejects.toThrow("transfer is unconfirmed");
  expect(fetcher).toHaveBeenCalledOnce();
});

it("rejects oversized candidates before transfer", async () => {
  const candidate = hostedCandidateFixture();
  candidate.patches[0].changes[0].after = "x".repeat(defaults.hostedMaxCandidateBodyBytes);
  const fetcher = vi.fn<typeof fetch>();
  await expect(new HostedAgentClient({ ...options, fetcher }).submitCandidate(candidate)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it("downloads a run-bound source bundle with bounded authenticated transport", async () => {
  const bytes = Buffer.from("private fixture source");
  const bundle = { runId: options.runId, baseSha: "a".repeat(40), files: [{ path: "app/page.tsx", mode: "100644",
    blobSha: createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex"), data: bytes.toString("base64") }] };
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(bundle)));
  expect(await new HostedAgentClient({ ...options, fetcher }).downloadInput()).toEqual(bundle);
  expect(fetcher.mock.calls[0]).toMatchObject(["https://agent.example/runs/run-1/input", { redirect: "error", credentials: "omit", body: "{}" }]);
});

it.each(["run", "hash", "size", "lost"])("rejects %s source transfers without retry", async kind => {
  const bytes = Buffer.from("private fixture source");
  const body = { runId: kind === "run" ? "other" : options.runId, baseSha: "a".repeat(40), files: [{ path: "app/page.tsx", mode: "100644",
    blobSha: kind === "hash" ? "0".repeat(40) : createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex"), data: bytes.toString("base64") }] };
  const fetcher = vi.fn<typeof fetch>(() => kind === "lost" ? Promise.reject(new Error("private fixture source")) : Promise.resolve(
    kind === "size" ? new Response("private fixture source", { headers: { "content-length": String(defaults.hostedMaxInputBodyBytes + 1) } }) : Response.json(body)));
  await expect(new HostedAgentClient({ ...options, fetcher }).downloadInput()).rejects.toThrow("Hosted input transfer is unconfirmed");
  expect(fetcher).toHaveBeenCalledOnce();
});
