import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FirestoreSpendLedger } from "../../src/hosted/firestore-spend-ledger.js";
import { createFakeFirestore } from "../helpers/fake-firestore.js";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-09T11:59:00.000Z")); });
afterEach(() => { vi.useRealTimers(); });
async function fixture() {
  const cloud = createFakeFirestore("spending"), options = { ...cloud.options, budgetId: "global-2026-10" };
  await FirestoreSpendLedger.initialize(options, { maxUsd: 1, history: [{ id: "old-unknown", upperBoundUsd: 0.2, note: "Historical upper bound" }] });
  await FirestoreSpendLedger.initialize({ ...options, budgetId: "installation-42-2026-10" }, { maxUsd: 1, history: [] });
  const scoped = { ...options, installationBudgetId: "installation-42-2026-10" }, ledger = await FirestoreSpendLedger.open(scoped);
  const id = await ledger.reserve("PRIVATE_MODEL", 0.1, "a".repeat(64));
  vi.setSystemTime(new Date("2026-10-09T12:01:00.000Z"));
  return { cloud, options, scoped, ledger, id };
}

it.each(["pending", "unknown", "settled"])("observes one %s reservation with the server version, no writes and no invented settled cost", async state => {
  const f = await fixture();
  if (state === "unknown") await f.ledger.recordUnknown(f.id);
  if (state === "settled") await f.ledger.settle(f.id, { inputTokens: 1, outputTokens: 2, costUsd: 0.003 });
  const before = JSON.stringify([...f.cloud.records]); f.cloud.calls.length = 0;
  const observed = await f.ledger.observeReservation(f.id);
  expect(observed).toEqual({ id: f.id, state, recordedAt: state === "pending" ? "2026-10-09T12:00:00.001Z" : "2026-10-09T12:00:00.002Z", costUsd: state === "settled" ? 0.003 : null });
  expect(f.cloud.calls.map(call => call.method)).toEqual(["GET"]); expect(JSON.stringify([...f.cloud.records])).toBe(before);
  expect(JSON.stringify(observed)).not.toMatch(/PRIVATE_MODEL|promptHash|reservedUsd|historyUpperBound|budgetId/);
  if (state === "settled") {
    await expect(f.ledger.settle(f.id, { inputTokens: 1, outputTokens: 1, costUsd: 0.1 })).rejects.toThrow(/already settled/);
    await expect(f.ledger.recordUnknown(f.id)).rejects.toThrow(/already settled/);
  }
});

it("rejects missing and differently scoped reservations instead of exporting another installation's cost", async () => {
  const f = await fixture(), unscoped = await FirestoreSpendLedger.open(f.options);
  await expect(unscoped.observeReservation(f.id)).rejects.toThrow(/Unknown budget/);
  await expect(f.ledger.observeReservation("11111111-1111-4111-8111-111111111111")).rejects.toThrow(/Unknown budget/);
});

it.each(["2026-10-09T11:00:00.000Z", "2099-10-09T12:00:00.000Z"])("refuses an impossible version timestamp (%s) without substituting client time", async updateTime => {
  const f = await fixture();
  const fetcher: typeof fetch = async (input, init) => {
    const response = await f.cloud.fetcher(input, init), uri = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!uri.endsWith("/" + f.id)) return response;
    const document = await response.json() as Record<string, unknown>; return Response.json({ ...document, updateTime });
  };
  const observer = await FirestoreSpendLedger.open({ ...f.scoped, fetcher });
  await expect(observer.observeReservation(f.id)).rejects.toThrow(/observation timestamp/);
});
