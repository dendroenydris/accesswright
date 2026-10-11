import assert from "node:assert/strict";
import { z } from "zod";

const bodySchema = z.object({ fields: z.object({ payload: z.object({ stringValue: z.string() }) }) });
const commitSchema = z.object({ writes: z.array(z.object({
  update: z.object({ name: z.string(), fields: bodySchema.shape.fields }),
  currentDocument: z.union([z.object({ exists: z.literal(false) }), z.object({ updateTime: z.string() })]),
  updateMask: z.object({ fieldPaths: z.array(z.literal("payload")) }).optional(),
})).min(2).max(3) });

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
      updateTime: new Date(Date.UTC(2026, 9, 9, 12) + data.rev).toISOString(),
      fields: { payload: { stringValue: data.payload } },
    });
    if (method === "POST" && uri.pathname.endsWith("/documents:commit")) {
      const body = commitSchema.parse(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
      const prefix = uri.pathname.slice("/v1/".length, -":commit".length) + "/" + collectionId + "/";
      const changes = body.writes.map(write => {
        assert.ok(write.update.name.startsWith(prefix));
        const id = write.update.name.slice(prefix.length);
        assert.ok(id && !id.includes("/"));
        return { id, write, before: records.get(id) };
      });
      if (changes.some(({ write, before }) => "exists" in write.currentDocument ? before !== undefined :
        !before || write.currentDocument.updateTime !== doc(before).updateTime)) {
        return Promise.resolve(new Response("private-source-leak", { status: 412 }));
      }
      const written = changes.map(({ id, write, before }) => {
        const after = { payload: write.update.fields.payload.stringValue, rev: (before?.rev ?? 0) + 1 };
        records.set(id, after);
        return { updateTime: doc(after).updateTime };
      });
      return Promise.resolve(Response.json({ writeResults: written, commitTime: written[0]?.updateTime }));
    }
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
