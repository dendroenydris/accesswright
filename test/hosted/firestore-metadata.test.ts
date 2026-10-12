import { expect, it } from "vitest";
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
