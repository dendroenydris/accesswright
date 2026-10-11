import { expect, it } from "vitest";
import { FirestoreHostedCheckoutRegistry } from "../../src/hosted/checkout-registry.js";
import { createFakeFirestore } from "../helpers/fake-firestore.js";
const run = { runId: "run1", repository: "owned/fixture", installationId: 42 }, sha = "a".repeat(40);

it("pins one original revision across service restarts and never replaces it with a newer branch head", async () => {
  const metadata = createFakeFirestore("checkoutPins"), registry = new FirestoreHostedCheckoutRegistry(metadata.options);
  await registry.register({ ...run, verifiedBaseSha: sha });
  expect(await new FirestoreHostedCheckoutRegistry(metadata.options).resolve(run)).toMatchObject({ ...run, verifiedBaseSha: sha });
  await expect(registry.register({ ...run, verifiedBaseSha: "b".repeat(40) })).rejects.toThrow("already exists");
  expect((await registry.resolve(run)).verifiedBaseSha).toBe(sha);
  const data = JSON.stringify([...metadata.records.values()]);
  expect(data).not.toMatch(/token|private-source|branch|credential/i);
});
it("refuses missing, cross-repository and cross-installation source identities", async () => {
  const registry = new FirestoreHostedCheckoutRegistry(createFakeFirestore("checkoutPins").options);
  await expect(registry.resolve(run)).rejects.toThrow("unconfirmed"); await registry.register({ ...run, verifiedBaseSha: sha });
  await expect(registry.resolve({ ...run, repository: "other/fixture" })).rejects.toThrow("unconfirmed");
  await expect(registry.resolve({ ...run, installationId: 43 })).rejects.toThrow("unconfirmed");
});
it("rejects moving refs, path aliases and extra credential fields before persistence", async () => {
  const metadata = createFakeFirestore("checkoutPins"), registry = new FirestoreHostedCheckoutRegistry(metadata.options);
  await expect(registry.register({ ...run, verifiedBaseSha: "main" })).rejects.toThrow();
  await expect(registry.register({ ...run, repository: "../fixture", verifiedBaseSha: sha })).rejects.toThrow();
  const injected = { ...run, verifiedBaseSha: sha, token: "fixture-credential" };
  await expect(registry.register(injected)).rejects.toThrow(); expect(metadata.records.size).toBe(0);
});
