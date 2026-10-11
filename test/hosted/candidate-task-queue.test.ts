import { expect, it, vi } from "vitest";
import { CloudTasksCandidateQueue } from "../../src/hosted/candidate-task-queue.js";
import { defaults } from "../../src/config.js";

const options = { projectId: "accesswright-dev-123", region: "europe-west1", queueId: "private-candidates",
  targetOrigin: "https://trusted-verifier.a.run.app", serviceAccountEmail: "candidate-tasks@accesswright-dev-123.iam.gserviceaccount.com",
  getAccessToken: () => Promise.resolve("trusted-workload-fixture") };
type Task = { name: string; scheduleTime: string; dispatchDeadline: string; httpRequest: { url: string; body: string; oidcToken: { audience: string; serviceAccountEmail: string } } };
function fixture() {
  const tasks = new Map<string, Task>(), calls: Array<{ url: string; method: string }> = [];
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    expect(url.origin).toBe("https://cloudtasks.googleapis.com");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer trusted-workload-fixture");
    expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
    const method = init?.method ?? "GET"; calls.push({ url: url.href, method });
    if (method === "POST") {
      if (typeof init?.body !== "string") throw new Error("Missing task metadata");
      const input = JSON.parse(init.body) as { task: Task; responseView: string }; expect(input.responseView).toBe("FULL");
      const task = { ...input.task, scheduleTime: input.task.scheduleTime ?? new Date().toISOString() };
      if (tasks.has(task.name)) return Promise.resolve(new Response(null, { status: 409 }));
      tasks.set(task.name, task); return Promise.resolve(Response.json(task));
    }
    expect(url.searchParams.get("responseView")).toBe("FULL");
    const task = tasks.get(url.pathname.slice("/v2/".length));
    return Promise.resolve(task ? Response.json(task) : new Response(null, { status: 404 }));
  };
  return { tasks, calls, fetcher, open: () => new CloudTasksCandidateQueue({ ...options, fetcher }) };
}

it("schedules only digest/expiry metadata to fixed authenticated endpoints and keeps existing exact tasks after restart", async () => {
  const f = fixture(), expiry = new Date(Date.now() + 900_000).toISOString();
  await f.open().enqueueVerification("run1", "f".repeat(64)); await f.open().enqueueExpiry("run1", expiry);
  const tasks = [...f.tasks.values()]; expect(tasks).toHaveLength(2);
  expect(JSON.parse(Buffer.from(tasks[0].httpRequest.body, "base64").toString())).toEqual({ runId: "run1", reportDigest: "f".repeat(64) });
  expect(tasks[0].dispatchDeadline).toBe(String(defaults.hostedVerificationDeadlineSeconds) + "s");
  expect(tasks[1].scheduleTime).toBe(expiry); expect(tasks[1].httpRequest.url).toBe(options.targetOrigin + "/internal/candidates/expire");
  expect(JSON.parse(Buffer.from(tasks[1].httpRequest.body, "base64").toString())).toEqual({ runId: "run1", expiresAt: expiry });
  for (const task of tasks) expect(task.httpRequest.oidcToken).toEqual({ serviceAccountEmail: options.serviceAccountEmail, audience: options.targetOrigin });
  expect(JSON.stringify(tasks)).not.toMatch(/trusted-workload-fixture|OPENAI_API_KEY|sourceExcerpt|patches|runToken/);
  await f.open().enqueueExpiry("run1", expiry); expect(f.calls.at(-1)?.method).toBe("GET"); expect(f.tasks.size).toBe(2);
  await expect(f.open().enqueueExpiry("run1", new Date(Date.parse(expiry) + 1000).toISOString())).rejects.toThrow("identity or deadline");
});

it("rejects reserved deleted task IDs rather than claiming they still schedule cleanup", async () => {
  const fetcher = vi.fn<typeof fetch>((_url, init) => Promise.resolve(new Response(null, { status: init?.method === "POST" ? 409 : 404 })));
  await expect(new CloudTasksCandidateQueue({ ...options, fetcher }).enqueueExpiry("run1", new Date(Date.now() + 900_000).toISOString())).rejects.toThrow("registration is unconfirmed");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("rejects task substitutions and oversized streamed registration responses", async () => {
  const f = fixture(); await f.open().enqueueVerification("run1", "f".repeat(64));
  const task = [...f.tasks.values()][0]; task.httpRequest.oidcToken.audience = "https://attacker.a.run.app";
  await expect(f.open().enqueueVerification("run1", "f".repeat(64))).rejects.toThrow("identity or deadline");
  const fetcher: typeof fetch = () => Promise.resolve(new Response("x".repeat(defaults.firestoreRecordMaxBytes + 1)));
  await expect(new CloudTasksCandidateQueue({ ...options, fetcher }).enqueueVerification("run1", "f".repeat(64))).rejects.toThrow("bound");
});

it("refuses untrusted destinations, cross-project identities and out-of-bounds expiry before requests", async () => {
  expect(() => new CloudTasksCandidateQueue({ ...options, targetOrigin: "https://attacker.example" })).toThrow("private Cloud Run");
  expect(() => new CloudTasksCandidateQueue({ ...options, serviceAccountEmail: "tasks@other-project-123.iam.gserviceaccount.com" })).toThrow("selected project");
  const f = fixture();
  await expect(f.open().enqueueExpiry("../run", new Date(Date.now() + 1000).toISOString())).rejects.toThrow();
  await expect(f.open().enqueueExpiry("run1", new Date(Date.now() - 1000).toISOString())).rejects.toThrow("bounded original");
  await expect(f.open().enqueueExpiry("run1", new Date(Date.now() + (defaults.hostedMaxTtlSeconds + 1) * 1000).toISOString())).rejects.toThrow("bounded original");
  expect(f.calls).toHaveLength(0);
});

it("does not retry an unknown transport reply or include its error payload", async () => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.reject(new Error("trusted-workload-fixture private-source-marker")));
  await expect(new CloudTasksCandidateQueue({ ...options, fetcher }).enqueueVerification("run1", "f".repeat(64))).rejects.toThrow("transport is unconfirmed");
  expect(fetcher).toHaveBeenCalledOnce();
});
