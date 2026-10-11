import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { SpendInitializationSchema } from "../llm/durable-spend.js";
import type { SpendInitialization, SpendLedger } from "../llm/durable-spend.js";
import type { LlmUsage } from "../llm/types.js";
import { FirestoreMetadataStore } from "./firestore-metadata.js";
import type { FirestoreMetadataOptions } from "./firestore-metadata.js";

const amount = z.number().finite().nonnegative();
const count = z.number().int().nonnegative().safe();
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const usageSchema = z.object({ inputTokens: count, outputTokens: count, costUsd: amount }).strict();
const budgetSchema = z.object({
  runId: idSchema, kind: z.literal("budget"), currency: z.literal("USD"), maxUsd: amount,
  historyDigest: z.string().regex(/^[a-f0-9]{64}$/), historyUpperBoundUsd: amount,
  settledUsd: amount, reservedUsd: amount, blocked: z.boolean(),
  pendingAttempts: count, unknownAttempts: count, settledAttempts: count,
}).strict().refine(budget => (budget.reservedUsd > 0) === (budget.pendingAttempts + budget.unknownAttempts > 0), "Outstanding reservations and aggregate allowance disagree");
const reservationSchema = z.object({
  runId: z.string().uuid(), kind: z.literal("reservation"), budgetId: idSchema,
  model: z.string().min(1).max(200), promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(), reservedUsd: amount.positive(),
  state: z.enum(["pending", "unknown", "settled"]), usage: usageSchema.optional(),
}).strict().refine(entry => (entry.state === "settled") === (entry.usage !== undefined), "Only settled reservations have usage");
const recordSchema = z.union([budgetSchema, reservationSchema]);
type Budget = z.infer<typeof budgetSchema>;
type Reservation = z.infer<typeof reservationSchema>;

export interface FirestoreSpendOptions extends FirestoreMetadataOptions { budgetId: string }

/** Shared cumulative cap with one atomic budget/reservation commit before each provider call. */
export class FirestoreSpendLedger implements SpendLedger {
  private readonly documents: FirestoreMetadataStore<z.infer<typeof recordSchema>>;
  private readonly budgetId: string;

  private constructor(options: FirestoreSpendOptions) {
    this.budgetId = idSchema.parse(options.budgetId);
    this.documents = new FirestoreMetadataStore(options, recordSchema);
  }

  static async initialize(options: FirestoreSpendOptions, input: SpendInitialization): Promise<FirestoreSpendLedger> {
    const policy = SpendInitializationSchema.parse(input);
    const historyUpperBoundUsd = policy.history.reduce((sum, item) => sum + item.upperBoundUsd, 0);
    if (historyUpperBoundUsd > policy.maxUsd) throw new Error("Historical allowance exceeds project budget");
    const ledger = new FirestoreSpendLedger(options);
    await ledger.documents.insert({ runId: ledger.budgetId, kind: "budget", currency: "USD", maxUsd: policy.maxUsd,
      historyDigest: createHash("sha256").update(JSON.stringify(policy.history)).digest("hex"), historyUpperBoundUsd,
      settledUsd: 0, reservedUsd: 0, blocked: false, pendingAttempts: 0, unknownAttempts: 0, settledAttempts: 0 });
    return ledger;
  }

  static async open(options: FirestoreSpendOptions): Promise<FirestoreSpendLedger> {
    const ledger = new FirestoreSpendLedger(options);
    await ledger.readBudget();
    return ledger;
  }

  private async readBudget(): Promise<{ record: Budget; updateTime: string }> {
    const current = await this.documents.getVersion(this.budgetId);
    if (!current || current.record.kind !== "budget") throw new Error("Cumulative budget record is absent");
    return { ...current, record: current.record };
  }

  async snapshot(): ReturnType<SpendLedger["snapshot"]> {
    const { record } = await this.readBudget();
    const committedUsd = record.historyUpperBoundUsd + record.settledUsd + record.reservedUsd;
    return { maxUsd: record.maxUsd, blocked: record.blocked, historyUpperBoundUsd: record.historyUpperBoundUsd,
      settledUsd: record.settledUsd, reservedUsd: record.reservedUsd, committedUsd,
      remainingUsd: Math.max(0, record.maxUsd - committedUsd), pendingAttempts: record.pendingAttempts,
      unknownAttempts: record.unknownAttempts, settledAttempts: record.settledAttempts };
  }

  async reserve(model: string, upperBoundUsd: number, promptHash: string): Promise<string> {
    const entry = reservationSchema.parse({ runId: randomUUID(), kind: "reservation", budgetId: this.budgetId,
      model, promptHash, createdAt: new Date().toISOString(), reservedUsd: upperBoundUsd, state: "pending" });
    const current = await this.readBudget();
    const budget = current.record;
    if (budget.blocked) throw new Error("Budget requires reconciliation before any further call");
    if (budget.historyUpperBoundUsd + budget.settledUsd + budget.reservedUsd + upperBoundUsd > budget.maxUsd + Number.EPSILON) {
      throw new Error("Cumulative project budget would be exceeded");
    }
    await this.documents.commitPair([
      { record: { ...budget, reservedUsd: budget.reservedUsd + upperBoundUsd, pendingAttempts: budget.pendingAttempts + 1 }, updateTime: current.updateTime },
      { record: entry, updateTime: null },
    ]);
    return entry.runId;
  }

  private async readReservation(id: string): Promise<{ record: Reservation; updateTime: string }> {
    const current = await this.documents.getVersion(z.string().uuid().parse(id));
    if (!current || current.record.kind !== "reservation" || current.record.budgetId !== this.budgetId) throw new Error("Unknown budget reservation");
    if (current.record.state === "settled") throw new Error("Budget reservation was already settled");
    return { ...current, record: current.record };
  }

  async settle(id: string, input: LlmUsage): Promise<void> {
    const usage = usageSchema.parse(input);
    const [current, claimed] = await Promise.all([this.readBudget(), this.readReservation(id)]);
    const budget = current.record, entry = claimed.record;
    const pendingAttempts = budget.pendingAttempts - (entry.state === "pending" ? 1 : 0);
    const unknownAttempts = budget.unknownAttempts - (entry.state === "unknown" ? 1 : 0);
    if (pendingAttempts < 0 || unknownAttempts < 0 || budget.reservedUsd + Number.EPSILON < entry.reservedUsd) throw new Error("Cumulative reservation accounting is inconsistent");
    const reservedUsd = pendingAttempts + unknownAttempts === 0 ? 0 : Math.max(0, budget.reservedUsd - entry.reservedUsd);
    const settledUsd = budget.settledUsd + usage.costUsd;
    const exceeded = usage.costUsd > entry.reservedUsd + Number.EPSILON;
    await this.documents.commitPair([
      { record: { ...budget, pendingAttempts, unknownAttempts, reservedUsd, settledUsd, settledAttempts: budget.settledAttempts + 1,
        blocked: budget.blocked || exceeded || budget.historyUpperBoundUsd + settledUsd + reservedUsd > budget.maxUsd + Number.EPSILON }, updateTime: current.updateTime },
      { record: { ...entry, state: "settled", usage }, updateTime: claimed.updateTime },
    ]);
    if (exceeded) throw new Error("Accounted usage exceeded its reservation; ledger blocked for reconciliation");
  }

  async recordUnknown(id: string): Promise<void> {
    const [current, claimed] = await Promise.all([this.readBudget(), this.readReservation(id)]);
    if (claimed.record.state === "unknown") return;
    if (current.record.pendingAttempts < 1) throw new Error("Cumulative reservation accounting is inconsistent");
    await this.documents.commitPair([
      { record: { ...current.record, pendingAttempts: current.record.pendingAttempts - 1, unknownAttempts: current.record.unknownAttempts + 1 }, updateTime: current.updateTime },
      { record: { ...claimed.record, state: "unknown" }, updateTime: claimed.updateTime },
    ]);
  }
}
