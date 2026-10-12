import { expect, it, vi } from "vitest";
import { z } from "zod";

import { FirestoreMetadataStore } from "../../src/hosted/firestore-metadata.js";

const schema = z.object({ runId: z.string(), spentUsd: z.number().nonnegative() }).strict();
function document(runId: string) {
  return { updateTime: "2026-10-12T01:00:00.000Z", fields: { payload: { stringValue: JSON.stringify({ runId, spentUsd: 0.75 }) } } };
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
