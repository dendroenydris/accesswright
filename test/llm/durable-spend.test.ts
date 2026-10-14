import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DurableSpendLedger } from "../../src/llm/durable-spend.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aw-spend-")); roots.push(root);
  const path = join(root, "spend.json");
  const ledger = await DurableSpendLedger.initialize(path, { maxUsd: 1, history: [{ id: "prior-unknown", upperBoundUsd: 0.2, note: "Conservative bound, not zero usage" }] });
  return { root, path, ledger };
}

it("reserves before calls and retains in-flight reservations across process restarts", async () => {
  const { path, ledger } = await fixture();
  const id = await ledger.reserve("fixture-model", 0.6, "a".repeat(64));
  const reopened = await DurableSpendLedger.open(path);
  expect(await reopened.snapshot()).toMatchObject({ historyUpperBoundUsd: 0.2, pendingAttempts: 1, committedUsd: 0.8 });
  await expect(reopened.reserve("fixture-model", 0.3, "b".repeat(64))).rejects.toThrow(/budget/i);
  await reopened.settle(id, { inputTokens: 10, outputTokens: 20, costUsd: 0.1 });
  expect(await ledger.snapshot()).toMatchObject({ historyUpperBoundUsd: 0.2, pendingAttempts: 0, settledUsd: 0.1 });
  await expect(ledger.settle(id, { inputTokens: 10, outputTokens: 20, costUsd: 0.1 })).rejects.toThrow(/settled/i);
});

it("does not recycle the allowance of a timed-out call whose usage is unknown", async () => {
  const { ledger } = await fixture();
  const id = await ledger.reserve("fixture-model", 0.6, "a".repeat(64));
  await ledger.recordUnknown(id);
  expect(await ledger.snapshot()).toMatchObject({ unknownAttempts: 1, committedUsd: 0.8 });
  await expect(ledger.reserve("fixture-model", 0.3, "b".repeat(64))).rejects.toThrow(/budget/i);
});

it("fails closed on missing, corrupt, or symbolic-link storage, and never overwrites history at initialization", async () => {
  const { root, path } = await fixture();
  await expect(DurableSpendLedger.initialize(path, { maxUsd: 100, history: [] })).rejects.toThrow();
  await expect(DurableSpendLedger.open(join(root, "missing.json"))).rejects.toThrow();
  await symlink(path, join(root, "alias.json"));
  await expect(DurableSpendLedger.open(join(root, "alias.json"))).rejects.toThrow();
  await writeFile(path, "incomplete metadata");
  await expect(DurableSpendLedger.open(path)).rejects.toThrow();
});

it("does not overspend when independent callers reserve concurrently", async () => {
  const { path, ledger } = await fixture();
  const other = await DurableSpendLedger.open(path);
  const results = await Promise.allSettled([ledger.reserve("fixture-model", 0.6, "a".repeat(64)), other.reserve("fixture-model", 0.6, "b".repeat(64))]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect((await ledger.snapshot()).committedUsd).toBeLessThanOrEqual(1);
  expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty("schemaVersion", 1);
});

it("preserves an overshoot as evidence and blocks future calls rather than hiding it", async () => {
  const { ledger } = await fixture();
  const id = await ledger.reserve("fixture-model", 0.1, "a".repeat(64));
  await expect(ledger.settle(id, { inputTokens: 1, outputTokens: 1, costUsd: 0.2 })).rejects.toThrow(/reservation/i);
  await expect(ledger.reserve("fixture-model", 0.01, "b".repeat(64))).rejects.toThrow(/reconciliation/i);
  expect(await ledger.snapshot()).toMatchObject({ blocked: true, settledUsd: 0.2 });
});

it("queues concurrent writes on one shared instance instead of failing them on the file lock", async () => {
  const { ledger } = await fixture();
  const ids = await Promise.all(["a", "b", "c", "d"].map(letter => ledger.reserve("fixture-model", 0.1, letter.repeat(64))));
  await Promise.all(ids.map(id => ledger.settle(id, { inputTokens: 1, outputTokens: 1, costUsd: 0.01 })));
  expect(await ledger.snapshot()).toMatchObject({ blocked: false, reservedUsd: 0 });
  expect((await ledger.snapshot()).settledUsd).toBeCloseTo(0.04);
});
