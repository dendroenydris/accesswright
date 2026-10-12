import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";

import { FirestoreDispatchClaims } from "../../src/hosted/firestore-dispatch-claims.js";
import { CloudRunJobInvoker } from "../../src/hosted/cloud-run-job.js";
import { CloudRunTaskDispatcher, createCloudRunTaskHandler } from "../../src/hosted/task-dispatch.js";
import type { QueuedRun } from "../../src/hosted/webhook.js";

const run: QueuedRun = {
  runId: "c".repeat(32), repository: "owner/private", installationId: 42,
  event: "installation", createdAt: "2026-10-09T13:00:00.000Z", pullNumber: null,
};
it("survives dispatcher restart: one durable Firestore claim, one Cloud Run job call, zero model/GitHub keys", async () => {
  const records = new Map<string, { payload: string; rev: number }>();
  let jobCalls = 0;
  const firestoreFetcher: typeof fetch = (input, init) => {
    const uri = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const id = method === "POST" ? uri.searchParams.get("documentId") ?? "" : uri.pathname.split("/").at(-1) ?? "";
    const current = records.get(id);
    const doc = (value: { payload: string; rev: number }) => ({
      name: "projects/accesswright-dev-123/databases/(default)/documents/accesswrightLaunchClaims/" + id,
      updateTime: "2026-10-09T13:00:" + String(value.rev).padStart(2, "0") + ".000Z",
      fields: { payload: { stringValue: value.payload } },
    });
    if (method === "GET") return Promise.resolve(current ? Response.json(doc(current)) : new Response(null, { status: 404 }));
    if (method === "POST" && current) return Promise.resolve(new Response(null, { status: 409 }));
    if (method === "POST" || method === "PATCH") {
      if (method === "PATCH" && (!current || uri.searchParams.get("currentDocument.updateTime") !== doc(current).updateTime)) {
        return Promise.resolve(new Response(null, { status: 412 }));
      }
      const submitted = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { fields: { payload: { stringValue: string } } };
      const next = { payload: submitted.fields.payload.stringValue, rev: (current?.rev ?? 0) + 1 };
      records.set(id, next);
      return Promise.resolve(Response.json(doc(next)));
    }
    return Promise.resolve(new Response(null, { status: 405 }));
  };
  const runApi = new CloudRunJobInvoker({
    projectId: "accesswright-dev-123", region: "europe-west3",
    jobId: "accesswright-worker", containerName: "accesswright",
    getAccessToken: () => Promise.resolve("fixture-identity"),
    fetcher: (_input, init) => {
      jobCalls++;
      const raw = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(raw) as { overrides: { containerOverrides: Array<{ env: Array<{ name: string; value: string }> }> } };
      const variables = Object.fromEntries(body.overrides.containerOverrides[0]?.env.map(item => [item.name, item.value]) ?? []);
      expect(variables.ACCESSWRIGHT_RUN_TOKEN).toHaveLength(64);
      expect(JSON.stringify(body)).not.toContain("OPENAI_API_KEY");
      expect(JSON.stringify(body)).not.toContain("GITHUB_TOKEN");
      return Promise.resolve(Response.json({
        name: "projects/accesswright-dev-123/locations/europe-west3/operations/one",
      }));
    },
  });
  const open = () => {
    const claims = new FirestoreDispatchClaims({
      projectId: "accesswright-dev-123", collectionId: "accesswrightLaunchClaims",
      getAccessToken: () => Promise.resolve("fixture-identity"), fetcher: firestoreFetcher,
    });
    return new CloudRunTaskDispatcher({
      authenticateTask: bearer => Promise.resolve(bearer === "Bearer fixture-oidc"),
      claim: input => claims.claim(input),
      registerRunToken: () => Promise.resolve("f".repeat(64)),
      invokeJob: (input, token) => runApi.start(input, token),
      recordOutcome: (input, operation) => claims.recordOutcome(input, operation),
    });
  };
  const server = createServer(createCloudRunTaskHandler(open()));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  const url = "http://127.0.0.1:" + address.port + "/internal/jobs";
  try {
    const headers = { authorization: "Bearer fixture-oidc", "content-type": "application/json" };
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify(run) })).status).toBe(202);
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify(run) })).status).toBe(200);
    expect(jobCalls).toBe(1);
    const newInstance = open();
    expect(await newInstance.dispatch(run, "Bearer fixture-oidc")).toMatchObject({ status: "duplicate" });
    expect(jobCalls).toBe(1);
    const stored = JSON.stringify([...records.values()]);
    expect(stored).toContain("launched");
    expect(stored).not.toContain("f".repeat(64));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
