import { expect, it } from "vitest";

import { FirestoreDispatchClaims } from "../../src/hosted/firestore-dispatch-claims.js";
import type { QueuedRun } from "../../src/hosted/webhook.js";

const run: QueuedRun = {
  runId: "a".repeat(32), repository: "owner/private", installationId: 42,
  event: "issue_comment", pullNumber: 7, createdAt: "2026-10-09T12:00:00.000Z",
};
function fixture() {
  const map = new Map<string, { value: string; version: number }>();
  const calls: string[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const uri = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    expect(uri.origin).toBe("https://firestore.googleapis.com");
    expect(headers.get("authorization")).toBe("Bearer local-dispatch-identity");
    const key = method === "POST" ? uri.searchParams.get("documentId") ?? "" : decodeURIComponent(uri.pathname.split("/").at(-1) ?? "");
    const existing = map.get(key);
    calls.push(method + " " + key);
    function doc(value: { value: string; version: number }) {
      return {
        updateTime: "2026-10-09T12:00:" + String(value.version).padStart(2, "0") + ".000Z",
        fields: { payload: { stringValue: value.value } },
      };
    }
    if (method === "GET") return Promise.resolve(existing ? Response.json(doc(existing)) : new Response(null, { status: 404 }));
    if (method === "POST") {
      if (existing) return Promise.resolve(new Response(null, { status: 409 }));
      const request = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { fields: { payload: { stringValue: string } } };
      const next = { value: request.fields.payload.stringValue, version: 1 };
      map.set(key, next);
      return Promise.resolve(Response.json(doc(next)));
    }
    if (method === "PATCH") {
      if (!existing) return Promise.resolve(new Response(null, { status: 404 }));
      if (uri.searchParams.get("currentDocument.updateTime") !== doc(existing).updateTime) return Promise.resolve(new Response(null, { status: 412 }));
      const request = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { fields: { payload: { stringValue: string } } };
      const next = { value: request.fields.payload.stringValue, version: existing.version + 1 };
      map.set(key, next);
      return Promise.resolve(Response.json(doc(next)));
    }
    return Promise.resolve(new Response(null, { status: 405 }));
  };
  return {
    records: map, calls,
    store: () => new FirestoreDispatchClaims({
      projectId: "accesswright-dev-123",
      collectionId: "accesswrightLaunchClaims",
      getAccessToken: () => Promise.resolve("local-dispatch-identity"),
      fetcher,
    }),
  };
}
it("creates exactly-once launch claims across dispatcher restarts, without source or scoped secrets", async () => {
  const f = fixture(), first = f.store(), second = f.store();
  expect(await first.claim(run)).toBe(true);
  expect(await second.claim(run)).toBe(false);
  expect(await second.read(run.runId)).toMatchObject({ runId: run.runId, status: "claimed" });
  expect(JSON.stringify([...f.records.values()])).not.toMatch(/OPENAI_API_KEY|GITHUB_TOKEN|private-source/);
  await first.recordOutcome(run, "projects/accesswright-dev-123/locations/europe-west3/operations/op1");
  expect(await second.read(run.runId)).toMatchObject({ status: "launched" });
  expect(f.calls.filter(call => call.startsWith("POST "))).toHaveLength(2);
});

it("treats an uncertain cloud dispatch as requires-reconciliation and never frees a claim", async () => {
  const f = fixture(), store = f.store();
  await store.claim(run);
  await store.recordOutcome(run, null);
  expect(await store.read(run.runId)).toMatchObject({ status: "requires-reconciliation" });
  expect(await f.store().claim(run)).toBe(false);
  await expect(store.recordOutcome({ ...run, repository: "attacker/other" }, null)).rejects.toThrow(/identity/i);
});

it("rejects unsafe firestore collections and never retries unknown metadata failures", async () => {
  expect(() => new FirestoreDispatchClaims({
    projectId: "../attacker", collectionId: "claims",
    getAccessToken: () => Promise.resolve("fixture"),
  })).toThrow(/project/i);
  let tries = 0;
  const store = new FirestoreDispatchClaims({
    projectId: "accesswright-dev-123", collectionId: "claims",
    getAccessToken: () => Promise.resolve("fixture"),
    fetcher: () => { tries++; return Promise.resolve(new Response("sensitive-resource", { status: 503 })); },
  });
  await expect(store.claim(run)).rejects.toThrow(/503/);
  expect(tries).toBe(1);
});
