import { expect, it, vi } from "vitest";
import { defaults } from "../../src/config.js";
import { HostedAgentClient } from "../../src/hosted/agent-client.js";
import type { FixTask } from "../../src/types/schemas.js";

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
