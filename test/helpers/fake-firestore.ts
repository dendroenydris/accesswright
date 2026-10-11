import assert from "node:assert/strict";
import { z } from "zod";

const bodySchema = z.object({ fields: z.object({ payload: z.object({ stringValue: z.string() }) }) });

export function createFakeFirestore(collectionId: string, pageSize?: number) {
  const records = new Map<string, { payload: string; rev: number }>();
  const calls: Array<{ method: string; path: string; precondition: string | null }> = [];
  const fetcher: typeof fetch = (input, init) => {
    const uri = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
    const method = init?.method ?? "GET";
    assert.equal(uri.origin, "https://firestore.googleapis.com");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer local-fixture-identity");
    calls.push({ method, path: uri.pathname, precondition: uri.searchParams.get("currentDocument.updateTime") });
    const key = method === "POST" ? (uri.searchParams.get("documentId") ?? "") : decodeURIComponent(uri.pathname.split("/").at(-1) ?? "");
    const current = records.get(key);
    const doc = (data: { payload: string; rev: number }) => ({
      updateTime: "2026-10-09T12:00:" + String(data.rev).padStart(2, "0") + ".000Z",
      fields: { payload: { stringValue: data.payload } },
    });
    if (method === "GET" && uri.searchParams.has("pageSize")) {
      const offset = Number(uri.searchParams.get("pageToken") ?? 0);
      const size = pageSize ?? Number(uri.searchParams.get("pageSize"));
      const entries = [...records.values()].slice(offset, offset + size);
      return Promise.resolve(Response.json({ documents: entries.map(doc),
        ...(offset + size < records.size ? { nextPageToken: String(offset + size) } : {}),
      }));
    }
    if (method === "GET") return Promise.resolve(current ? Response.json(doc(current)) : new Response(null, { status: 404 }));
    if (method === "POST" || method === "PATCH") {
      if (method === "POST" && current) return Promise.resolve(new Response("private-source-leak", { status: 409 }));
      if (method === "PATCH") {
        if (!current) return Promise.resolve(new Response(null, { status: 404 }));
        if (uri.searchParams.get("currentDocument.updateTime") !== doc(current).updateTime) {
          return Promise.resolve(new Response("private-source-leak", { status: 412 }));
        }
      }
      const body = bodySchema.parse(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
      const next = { payload: body.fields.payload.stringValue, rev: (current?.rev ?? 0) + 1 };
      records.set(key, next);
      return Promise.resolve(Response.json(doc(next)));
    }
    return Promise.resolve(new Response(null, { status: 405 }));
  };
  return {
    records, calls, fetcher,
    options: { projectId: "accesswright-dev-123", collectionId,
      getAccessToken: () => Promise.resolve("local-fixture-identity"), fetcher },
  };
}
