import { expect, it, vi } from "vitest";
import { FirestoreCandidateCleanupStore, clearHostedCandidate } from "../../src/hosted/candidate-cleanup.js";
import { createFakeFirestore } from "../helpers/fake-firestore.js";

const reference = { generation: "12345678901234567890", candidateDigest: "f".repeat(64), expiresAt: "2026-10-11T21:00:00.000Z" };
function fixture() {
  const f = createFakeFirestore("candidateCleanup");
  return { ...f, open: () => new FirestoreCandidateCleanupStore(f.options) };
}

it("persists fixed generation/deadline identity across restart and records confirmed deletion without source", async () => {
  const f = fixture(), first = f.open();
  expect(await first.claim("run1", reference)).toMatchObject({ status: "pending", clearedAt: null });
  const restarted = f.open(), remove = vi.fn(() => Promise.resolve());
  await clearHostedCandidate({ cleanup: restarted, store: { remove } }, "run1", reference);
  expect(remove).toHaveBeenCalledExactlyOnceWith("run1", reference.generation);
  expect(await first.get("run1")).toMatchObject({ ...reference, status: "cleared" });
  expect((await first.get("run1"))?.clearedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(await restarted.claim("run1", reference)).toMatchObject({ status: "cleared" });
  expect(JSON.stringify([...f.records.values()])).not.toMatch(/sourceExcerpt|patches|OPENAI_API_KEY|token|private-source/);
});

it("rejects changed generations, payloads and expiry rather than reopening deletion authority", async () => {
  const f = fixture(); await f.open().claim("run1", reference);
  for (const changed of [{ ...reference, generation: "2" }, { ...reference, candidateDigest: "a".repeat(64) }, { ...reference, expiresAt: "2026-10-11T22:00:00.000Z" }]) {
    await expect(f.open().claim("run1", changed)).rejects.toThrow("identity changed");
  }
  await expect(f.open().confirm("run1", "2")).rejects.toThrow("generation changed");
  expect((await f.open().get("run1"))?.status).toBe("pending");
});

it("retains a pending receipt if physical deletion is unconfirmed", async () => {
  const f = fixture(), remove = vi.fn(() => Promise.reject(new Error("recoverable object")));
  await expect(clearHostedCandidate({ cleanup: f.open(), store: { remove } }, "run1", reference)).rejects.toThrow("recoverable object");
  expect((await f.open().get("run1"))?.status).toBe("pending"); expect(remove).toHaveBeenCalledOnce();
});

it("recovers a lost cleanup metadata confirmation without repeating verification", async () => {
  const f = fixture(), remove = vi.fn<(runId: string, generation: string) => Promise<void>>(() => Promise.resolve());
  const first = f.open(), confirm = vi.fn(() => Promise.reject(new Error("metadata response lost")));
  await expect(clearHostedCandidate({ cleanup: { claim: (id, ref) => first.claim(id, ref), confirm }, store: { remove } }, "run1", reference)).rejects.toThrow("metadata response lost");
  expect((await f.open().get("run1"))?.status).toBe("pending");
  await clearHostedCandidate({ cleanup: f.open(), store: { remove } }, "run1", reference);
  expect((await f.open().get("run1"))?.status).toBe("cleared"); expect(remove).toHaveBeenCalledTimes(2);
  expect(remove.mock.calls.every(call => call[1] === reference.generation)).toBe(true);
});

it("still erases owned source if cleanup metadata is unavailable, but withholds confirmation", async () => {
  const remove = vi.fn(() => Promise.resolve()), confirm = vi.fn(() => Promise.reject(new Error("must not confirm")));
  await expect(clearHostedCandidate({ store: { remove }, cleanup: { claim: () => Promise.reject(new Error("metadata unavailable")), confirm } }, "run1", reference)).rejects.toThrow("metadata unavailable");
  expect(remove).toHaveBeenCalledExactlyOnceWith("run1", reference.generation); expect(confirm).not.toHaveBeenCalled();
});

it("never deletes a different object generation when the durable cleanup identity rejects it", async () => {
  const f = fixture(), remove = vi.fn(() => Promise.resolve()); await f.open().claim("run1", reference);
  await expect(clearHostedCandidate({ cleanup: f.open(), store: { remove } }, "run1", { ...reference, generation: "2" })).rejects.toThrow("identity changed");
  expect(remove).not.toHaveBeenCalled();
});
