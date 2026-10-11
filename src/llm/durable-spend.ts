import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { LlmUsage } from "./types.js";

const amount = z.number().finite().nonnegative();
const usageSchema = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), costUsd: amount }).strict();
const historySchema = z.object({ id: z.string().min(1), upperBoundUsd: amount, note: z.string().min(1) }).strict();
const entrySchema = z.object({ id: z.string().uuid(), model: z.string().min(1).max(200), promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(), reservedUsd: amount, state: z.enum(["pending", "unknown", "settled"]), usage: usageSchema.optional() }).strict().refine(
    entry => entry.state === "settled" ? entry.usage !== undefined : entry.usage === undefined,
    "Only settled entries may have accounted usage",
  );
const storeSchema = z.object({ schemaVersion: z.literal(1), currency: z.literal("USD"), maxUsd: amount, history: z.array(historySchema),
  blocked: z.boolean(), entries: z.array(entrySchema) }).strict().refine(
    store => new Set(store.history.map(item => item.id)).size === store.history.length && new Set(store.entries.map(item => item.id)).size === store.entries.length,
    "Budget entries must have unique identities",
  );
type Store = z.infer<typeof storeSchema>;
export interface SpendInitialization { maxUsd: number; history: Array<z.infer<typeof historySchema>> }
export const SpendInitializationSchema = z.object({ maxUsd: amount, history: z.array(historySchema) }).strict()
  .refine(policy => new Set(policy.history.map(item => item.id)).size === policy.history.length, "Budget history must have unique identities");
export type SpendLedger = Pick<DurableSpendLedger, "reserve" | "settle" | "recordUnknown" | "snapshot">;

function totals(store: Store) {
  const historyUpperBoundUsd = store.history.reduce((sum, item) => sum + item.upperBoundUsd, 0);
  const settledUsd = store.entries.reduce((sum, entry) => sum + (entry.usage?.costUsd ?? 0), 0);
  const reservedUsd = store.entries.reduce((sum, entry) => sum + (entry.state === "settled" ? 0 : entry.reservedUsd), 0);
  const committedUsd = historyUpperBoundUsd + settledUsd + reservedUsd;
  return { maxUsd: store.maxUsd, blocked: store.blocked, historyUpperBoundUsd, settledUsd, reservedUsd, committedUsd,
    remainingUsd: Math.max(0, store.maxUsd - committedUsd), pendingAttempts: store.entries.filter(entry => entry.state === "pending").length,
    unknownAttempts: store.entries.filter(entry => entry.state === "unknown").length, settledAttempts: store.entries.filter(entry => entry.state === "settled").length };
}

/**
 * Operator-owned, metadata-only cumulative allowance. Persist a reservation BEFORE
 * each transport call. A crash or unknown response never silently releases money.
 * Exclusive lock conflicts fail closed; abandoned locks require explicit reconciliation.
 */
export class DurableSpendLedger {
  private readonly path: string;
  private constructor(path: string) { this.path = resolve(path); }

  static async initialize(path: string, policy: SpendInitialization): Promise<DurableSpendLedger> {
    const ledger = new DurableSpendLedger(path);
    await mkdir(dirname(ledger.path), { recursive: true, mode: 0o700 });
    const store = storeSchema.parse({ schemaVersion: 1, currency: "USD", ...policy, blocked: false, entries: [] });
    if (totals(store).committedUsd > store.maxUsd) throw new Error("Historical allowance exceeds project budget");
    const file = await open(ledger.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8"); await file.sync(); }
    finally { await file.close(); }
    return ledger;
  }

  static async open(path: string): Promise<DurableSpendLedger> {
    const ledger = new DurableSpendLedger(path);
    await ledger.read();
    return ledger;
  }

  private async read(): Promise<Store> {
    const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Budget storage must be a bounded regular file");
      return storeSchema.parse(JSON.parse(await file.readFile("utf8")));
    } finally { await file.close(); }
  }

  private async mutate<T>(change: (store: Store) => T): Promise<T> {
    const lock = `${this.path}.lock`;
    try { await mkdir(lock, { mode: 0o700 }); }
    catch { throw new Error("Budget ledger is locked; retry only after the active writer finishes or reconcile a stale lock"); }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let temporaryCreated = false;
    try {
      const store = await this.read();
      const result = change(store);
      storeSchema.parse(store);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temporaryCreated = true;
      try { await file.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8"); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
      temporaryCreated = false;
      const directory = await open(dirname(this.path), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
      return result;
    } finally {
      if (temporaryCreated) await unlink(temporary);
      await rmdir(lock);
    }
  }

  async reserve(model: string, upperBoundUsd: number, promptHash: string): Promise<string> {
    const entry = entrySchema.parse({ id: randomUUID(), model, promptHash, createdAt: new Date().toISOString(), reservedUsd: upperBoundUsd, state: "pending" });
    if (upperBoundUsd <= 0) throw new Error("Paid calls require a positive conservative reservation");
    return this.mutate(store => {
      if (store.blocked) throw new Error("Budget requires reconciliation before any further call");
      if (totals(store).committedUsd + upperBoundUsd > store.maxUsd + Number.EPSILON) throw new Error("Cumulative project budget would be exceeded");
      store.entries.push(entry);
      return entry.id;
    });
  }

  async settle(id: string, input: LlmUsage): Promise<void> {
    const usage = usageSchema.parse(input);
    const exceeded = await this.mutate(store => {
      const entry = store.entries.find(entry => entry.id === id);
      if (!entry) throw new Error("Unknown budget reservation");
      if (entry.state === "settled") throw new Error("Budget reservation was already settled");
      entry.state = "settled";
      entry.usage = usage;
      const excess = usage.costUsd > entry.reservedUsd + Number.EPSILON;
      store.blocked ||= excess || totals(store).committedUsd > store.maxUsd + Number.EPSILON;
      return excess;
    });
    if (exceeded) throw new Error("Accounted usage exceeded its reservation; ledger blocked for reconciliation");
  }

  async recordUnknown(id: string): Promise<void> {
    await this.mutate(store => {
      const entry = store.entries.find(entry => entry.id === id);
      if (!entry || entry.state === "settled") throw new Error("Missing or already settled budget reservation");
      entry.state = "unknown";
    });
  }

  async snapshot() { return totals(await this.read()); }
}
