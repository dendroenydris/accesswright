import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { defaults } from "../config.js";
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
  installationBudgetId: idSchema.optional(),
  model: z.string().min(1).max(200), promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(), reservedUsd: amount.positive(),
  state: z.enum(["pending", "unknown", "settled"]), usage: usageSchema.optional(),
}).strict().refine(entry => (entry.state === "settled") === (entry.usage !== undefined), "Only settled reservations have usage");
const recordSchema = z.union([budgetSchema, reservationSchema]);
type Budget = z.infer<typeof budgetSchema>;
type Reservation = z.infer<typeof reservationSchema>;

export interface FirestoreSpendOptions extends FirestoreMetadataOptions { budgetId: string; installationBudgetId?: string }

/** Shared cumulative cap with one atomic budget/reservation commit before each provider call. */
export class FirestoreSpendLedger implements SpendLedger {
  private readonly documents: FirestoreMetadataStore<z.infer<typeof recordSchema>>;
  private readonly budgetId: string;
  private readonly installationBudgetId?: string;

  private constructor(options: FirestoreSpendOptions) {
    this.budgetId = idSchema.parse(options.budgetId);
    this.installationBudgetId = options.installationBudgetId === undefined ? undefined : idSchema.parse(options.installationBudgetId);
    if (this.installationBudgetId === this.budgetId) throw new Error("Global and installation allowances must be distinct");
    this.documents = new FirestoreMetadataStore(options, recordSchema);
  }

  static async initialize(options: FirestoreSpendOptions, input: SpendInitialization): Promise<FirestoreSpendLedger> {
    if (options.installationBudgetId !== undefined) throw new Error("Initialize global and installation allowances separately");
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
    await ledger.readBudgets();
    return ledger;
  }

  private async readBudget(id = this.budgetId): Promise<{ record: Budget; updateTime: string }> {
    const current = await this.documents.getVersion(id);
    if (!current || current.record.kind !== "budget") throw new Error("Cumulative budget record is absent");
    return { ...current, record: current.record };
  }

  private async readBudgets(): Promise<Array<{ record: Budget; updateTime: string }>> {
    return Promise.all([this.readBudget(), ...(this.installationBudgetId ? [this.readBudget(this.installationBudgetId)] : [])]);
  }

  async snapshot(): ReturnType<SpendLedger["snapshot"]> {
    const budgets = await this.readBudgets();
    // Report the most restrictive allowance; each reserve still checks both.
    const { record } = budgets.reduce((lowest, current) =>
      current.record.maxUsd - current.record.historyUpperBoundUsd - current.record.settledUsd - current.record.reservedUsd <
      lowest.record.maxUsd - lowest.record.historyUpperBoundUsd - lowest.record.settledUsd - lowest.record.reservedUsd ? current : lowest);
    const committedUsd = record.historyUpperBoundUsd + record.settledUsd + record.reservedUsd;
    return { maxUsd: record.maxUsd, blocked: budgets.some(budget => budget.record.blocked), historyUpperBoundUsd: record.historyUpperBoundUsd,
      settledUsd: record.settledUsd, reservedUsd: record.reservedUsd, committedUsd,
      remainingUsd: Math.max(0, record.maxUsd - committedUsd), pendingAttempts: record.pendingAttempts,
      unknownAttempts: record.unknownAttempts, settledAttempts: record.settledAttempts };
  }

  async reserve(model: string, upperBoundUsd: number, promptHash: string): Promise<string> {
    const entry = reservationSchema.parse({ runId: randomUUID(), kind: "reservation", budgetId: this.budgetId,
      ...(this.installationBudgetId ? { installationBudgetId: this.installationBudgetId } : {}),
      model, promptHash, createdAt: new Date().toISOString(), reservedUsd: upperBoundUsd, state: "pending" });
    const budgets = await this.readBudgets();
    for (const { record: budget } of budgets) {
      if (budget.blocked) throw new Error("Budget requires reconciliation before any further call");
      if (budget.historyUpperBoundUsd + budget.settledUsd + budget.reservedUsd + upperBoundUsd > budget.maxUsd + Number.EPSILON) {
        throw new Error("Cumulative project or installation budget would be exceeded");
      }
    }
    await this.documents.commit([
      ...budgets.map(({ record: budget, updateTime }) => ({ record: { ...budget, reservedUsd: budget.reservedUsd + upperBoundUsd, pendingAttempts: budget.pendingAttempts + 1 }, updateTime })),
      { record: entry, updateTime: null },
    ]);
    return entry.runId;
  }

  private async readReservation(id: string): Promise<{ record: Reservation; updateTime: string }> {
    const current = await this.documents.getVersion(z.string().uuid().parse(id));
    if (!current || current.record.kind !== "reservation" || current.record.budgetId !== this.budgetId ||
      current.record.installationBudgetId !== this.installationBudgetId) throw new Error("Unknown budget reservation");
    if (current.record.state === "settled") throw new Error("Budget reservation was already settled");
    return { ...current, record: current.record };
  }

  async settle(id: string, input: LlmUsage): Promise<void> {
    const usage = usageSchema.parse(input);
    const [budgets, claimed] = await Promise.all([this.readBudgets(), this.readReservation(id)]);
    const entry = claimed.record;
    const exceeded = usage.costUsd > entry.reservedUsd + Number.EPSILON;
    const changes = budgets.map(({ record: budget, updateTime }) => {
      const pendingAttempts = budget.pendingAttempts - (entry.state === "pending" ? 1 : 0);
      const unknownAttempts = budget.unknownAttempts - (entry.state === "unknown" ? 1 : 0);
      if (pendingAttempts < 0 || unknownAttempts < 0 || budget.reservedUsd + Number.EPSILON < entry.reservedUsd) throw new Error("Cumulative reservation accounting is inconsistent");
      const reservedUsd = pendingAttempts + unknownAttempts === 0 ? 0 : Math.max(0, budget.reservedUsd - entry.reservedUsd);
      const settledUsd = budget.settledUsd + usage.costUsd;
      return { record: { ...budget, pendingAttempts, unknownAttempts, reservedUsd, settledUsd, settledAttempts: budget.settledAttempts + 1,
        blocked: budget.blocked || exceeded || budget.historyUpperBoundUsd + settledUsd + reservedUsd > budget.maxUsd + Number.EPSILON }, updateTime };
    });
    await this.documents.commit([
      ...changes,
      { record: { ...entry, state: "settled", usage }, updateTime: claimed.updateTime },
    ]);
    if (exceeded) throw new Error("Accounted usage exceeded its reservation; ledger blocked for reconciliation");
  }

  async recordUnknown(id: string): Promise<void> {
    const [budgets, claimed] = await Promise.all([this.readBudgets(), this.readReservation(id)]);
    if (claimed.record.state === "unknown") return;
    if (budgets.some(current => current.record.pendingAttempts < 1)) throw new Error("Cumulative reservation accounting is inconsistent");
    await this.documents.commit([
      ...budgets.map(current => ({ record: { ...current.record, pendingAttempts: current.record.pendingAttempts - 1, unknownAttempts: current.record.unknownAttempts + 1 }, updateTime: current.updateTime })),
      { record: { ...claimed.record, state: "unknown" }, updateTime: claimed.updateTime },
    ]);
  }
}

/** Missing monthly policy is a denial, never an automatic fresh allowance. */
export async function openMonthlyHostedSpend(options: FirestoreMetadataOptions, installationId: number): Promise<FirestoreSpendLedger> {
  const id = z.number().int().positive().safe().parse(installationId);
  const month = new Date().toISOString().slice(0, 7);
  return FirestoreSpendLedger.open({ ...options,
    budgetId: defaults.hostedGlobalBudgetPrefix + month,
    installationBudgetId: defaults.hostedInstallationBudgetPrefix + id + "-" + month,
  });
}
