import { expect, it, vi } from "vitest";
import { z } from "zod";

import { FirestoreMetadataStore } from "../../src/hosted/firestore-metadata.js";

const schema = z.object({ runId: z.string(), spentUsd: z.number().nonnegative() }).strict();
function document(runId: string) {
  return { name: "projects/accesswright-dev-123/databases/(default)/documents/authorizations/" + runId,
    updateTime: "2026-10-12T01:00:00.000Z", fields: { payload: { stringValue: JSON.stringify({ runId, spentUsd: 0.75 }) } } };
}
function store(pages: unknown[]) {
  let page = 0;
  return new FirestoreMetadataStore({ projectId: "accesswright-dev-123", collectionId: "authorizations",
    getAccessToken: () => Promise.resolve("fixture-workload-identity"),
    fetcher: () => Promise.resolve(Response.json(pages[page++])),
  }, schema);
}

it("rejects repeated run identities within a metadata page instead of duplicating recorded cost", async () => {
  await expect(store([{ documents: [document("same"), document("same")] }]).records()).rejects.toThrow(/Duplicate.*run/i);
});

it.each([undefined, "projects/other-project/databases/(default)/documents/authorizations/one",
  "projects/accesswright-dev-123/databases/other-db/documents/authorizations/one",
  "projects/accesswright-dev-123/databases/(default)/documents/other/one",
  "projects/accesswright-dev-123/databases/(default)/documents/authorizations/misfiled",
  "projects/accesswright-dev-123/databases/%28default%29/documents/authorizations/one",
])("refuses an unbound document resource (%s) in both single reads and snapshot pages", async name => {
  const doc = { ...document("one"), name };
  await expect(store([doc]).get("one")).rejects.toThrow();
  await expect(store([{ documents: [doc] }]).records()).rejects.toThrow();
});

it.each(["(default)", "named-db"])("uses canonical %s resource names in atomic writes with unchanged preconditions", async databaseId => {
  const metadata = new FirestoreMetadataStore({ projectId: "accesswright-dev-123", databaseId, collectionId: "authorizations",
    getAccessToken: () => Promise.resolve("fixture-identity"), fetcher: (input, init) => {
      expect(input instanceof URL ? input.href : typeof input === "string" ? input : input.url)
        .toContain("/databases/" + encodeURIComponent(databaseId) + "/documents:commit");
      if (typeof init?.body !== "string") throw new Error("Missing atomic metadata payload");
      const writes = z.object({ writes: z.array(z.object({ update: z.object({ name: z.string() }), currentDocument: z.unknown() })) })
        .parse(JSON.parse(init.body) as unknown).writes;
      expect(writes.map(write => write.update.name)).toEqual(["one", "two"].map(id =>
        "projects/accesswright-dev-123/databases/" + databaseId + "/documents/authorizations/" + id));
      expect(writes.map(write => write.currentDocument)).toEqual([{ exists: false }, { updateTime: document("two").updateTime }]);
      return Promise.resolve(Response.json({ writeResults: writes.map(() => ({ updateTime: document("one").updateTime })),
        commitTime: document("one").updateTime }));
    } }, schema);
  await metadata.commit([{ record: { runId: "one", spentUsd: 0 }, updateTime: null },
    { record: { runId: "two", spentUsd: 0.75 }, updateTime: document("two").updateTime }]);
});

it.each(["insert", "update"] as const)("rejects a %s acknowledgment bound to a different document", async operation => {
  const wrong = { ...document("one"), name: document("other").name };
  const metadata = store(operation === "insert" ? [wrong] : [document("one"), wrong]);
  await expect(operation === "insert" ? metadata.insert({ runId: "one", spentUsd: 0.75 }) : metadata.update("one", record => record)).rejects.toThrow();
});

it("rejects repeated run identities across distinct metadata pages", async () => {
  await expect(store([{ documents: [document("same")], nextPageToken: "distinct-page" }, { documents: [document("same")] }]).records()).rejects.toThrow(/Duplicate.*run/i);
});

it("preserves all unique metadata and refuses repeated pagination tokens", async () => {
  expect(await store([{ documents: [document("one")], nextPageToken: "next" }, { documents: [document("two")] }]).records())
    .toEqual([{ runId: "one", spentUsd: 0.75 }, { runId: "two", spentUsd: 0.75 }]);
  await expect(store([{ nextPageToken: "loop" }, { nextPageToken: "loop" }]).records()).rejects.toThrow(/pagination/);
});

it("pins every metadata page to the same snapshot despite writes between pages", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T01:01:00.000Z"));
  const queries: URL[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
    queries.push(url); expect(init?.method).toBe("GET");
    if (queries.length === 1) {
      vi.setSystemTime(new Date("2026-10-12T01:02:00.000Z"));
      return Promise.resolve(Response.json({ documents: [document("one")], nextPageToken: "next-page" }));
    }
    // A current-state second page loses the row deleted after the first page.
    return Promise.resolve(Response.json({ documents: url.searchParams.get("readTime") === "2026-10-12T01:01:00.000Z" ? [document("two")] : [] }));
  };
  try {
    const metadata = new FirestoreMetadataStore({ projectId: "accesswright-dev-123", collectionId: "authorizations",
      getAccessToken: () => Promise.resolve("fixture-workload-identity"), fetcher }, schema);
    expect(await metadata.records()).toEqual([{ runId: "one", spentUsd: 0.75 }, { runId: "two", spentUsd: 0.75 }]);
    expect(queries.map(url => url.searchParams.get("readTime"))).toEqual(["2026-10-12T01:01:00.000Z", "2026-10-12T01:01:00.000Z"]);
    expect(queries.map(url => url.searchParams.get("pageToken"))).toEqual([null, "next-page"]);
  } finally { vi.useRealTimers(); }
});

it("withholds partial listings when the cloud refuses the fixed snapshot, without a latest-state fallback", async () => {
  const queries: URL[] = [];
  const fetcher: typeof fetch = input => {
    const url = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url); queries.push(url);
    if (queries.length === 1) return Promise.resolve(Response.json({ documents: [document("one")], nextPageToken: "next-page" }));
    return Promise.resolve(url.searchParams.has("readTime") ? new Response(null, { status: 400 }) : Response.json({ documents: [document("two")] }));
  };
  const metadata = new FirestoreMetadataStore({ projectId: "accesswright-dev-123", collectionId: "authorizations",
    getAccessToken: () => Promise.resolve("fixture-workload-identity"), fetcher }, schema);
  await expect(metadata.records()).rejects.toThrow(/list failed/);
  expect(queries).toHaveLength(2); expect(queries[1].searchParams.get("readTime")).toBe(queries[0].searchParams.get("readTime"));
});

it("keeps document versions from the requested snapshot without rereading latest state", async () => {
  const readTime = "2026-10-12T01:01:00.000Z";
  expect(await store([{ documents: [document("one")] }]).versions(readTime)).toEqual([
    { record: { runId: "one", spentUsd: 0.75 }, updateTime: document("one").updateTime },
  ]);
});

it("refuses versions newer than the pinned snapshot and invalid read times", async () => {
  await expect(store([{ documents: [document("one")] }]).versions("2026-10-12T00:59:00.000Z")).rejects.toThrow(/version/);
  await expect(store([]).versions("invalid")).rejects.toThrow();
});
