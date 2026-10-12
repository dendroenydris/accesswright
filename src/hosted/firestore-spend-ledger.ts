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

function observeVersion(record: Reservation, updateTime: string, observedAt: string) {
  if (!z.iso.datetime().safeParse(updateTime).success || Date.parse(updateTime) < Date.parse(record.createdAt) ||
    Date.parse(updateTime) > Date.parse(observedAt)) throw new Error("Unconfirmed usage observation timestamp");
  return { id: record.runId, recordedAt: updateTime, state: record.state, costUsd: record.state === "settled" ? record.usage?.costUsd ?? null : null };
}

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
    return { ...current, record: current.record };
  }

  /** One scoped call's server-version observation, never reserved or historical spend. */
  async observeReservation(id: string) {
    const { record, updateTime } = await this.readReservation(id);
    return observeVersion(record, updateTime, new Date().toISOString());
  }

  /** Enumerate original scopes and reconcile every reservation against the same snapshot's cumulative policies. */
  static async observeCollection(options: FirestoreMetadataOptions, readTime: string) {
    const documents = await new FirestoreMetadataStore(options, recordSchema).versions(readTime);
    const budgets = documents.map(document => document.record).filter(record => record.kind === "budget");
    const reservations = documents.filter(document => document.record.kind === "reservation").map(document => ({
      record: reservationSchema.parse(document.record), updateTime: document.updateTime,
    }));
    const globalMonths = budgets.filter(budget => budget.runId.startsWith(defaults.hostedGlobalBudgetPrefix))
      .map(budget => budget.runId.slice(defaults.hostedGlobalBudgetPrefix.length));
    const month = /^\d{4}-(?:0[1-9]|1[0-2])$/;
    const scoped = reservations.every(({ record }) => {
      const originalMonth = record.budgetId.slice(defaults.hostedGlobalBudgetPrefix.length);
      return record.budgetId.startsWith(defaults.hostedGlobalBudgetPrefix) && month.test(originalMonth) &&
        record.installationBudgetId !== undefined && record.installationBudgetId.startsWith(defaults.hostedInstallationBudgetPrefix) &&
        new RegExp("^[1-9][0-9]*-" + originalMonth + "$", "u").test(record.installationBudgetId.slice(defaults.hostedInstallationBudgetPrefix.length)) &&
        budgets.some(budget => budget.runId === record.budgetId) && budgets.some(budget => budget.runId === record.installationBudgetId);
    });
    const reconciled = scoped && globalMonths.every(value => month.test(value)) && budgets.every(budget => {
      if (!budget.runId.startsWith(defaults.hostedGlobalBudgetPrefix) &&
        (!budget.runId.startsWith(defaults.hostedInstallationBudgetPrefix) ||
          !/^[1-9][0-9]*-\d{4}-(?:0[1-9]|1[0-2])$/.test(budget.runId.slice(defaults.hostedInstallationBudgetPrefix.length)))) return false;
      const entries = reservations.map(document => document.record).filter(entry => entry.budgetId === budget.runId || entry.installationBudgetId === budget.runId);
      const settled = entries.filter(entry => entry.state === "settled"), unsettled = entries.filter(entry => entry.state !== "settled");
      const equal = (left: number, right: number) => Math.abs(left - right) <= Number.EPSILON * Math.max(1, left, right) * Math.max(1, entries.length);
      return budget.settledAttempts === settled.length && budget.pendingAttempts === entries.filter(entry => entry.state === "pending").length &&
        budget.unknownAttempts === entries.filter(entry => entry.state === "unknown").length &&
        equal(budget.settledUsd, settled.reduce((sum, entry) => sum + (entry.usage?.costUsd ?? 0), 0)) &&
        equal(budget.reservedUsd, unsettled.reduce((sum, entry) => sum + entry.reservedUsd, 0));
    });
    return { reconciled, globalMonths, historicalUsageUnknown: budgets.some(budget => budget.historyUpperBoundUsd > 0),
      reservations: reservations.map(({ record, updateTime }) => ({ ...observeVersion(record, updateTime, readTime), createdAt: record.createdAt })) };
  }

  async settle(id: string, input: LlmUsage): Promise<void> {
    const usage = usageSchema.parse(input);
    const [budgets, claimed] = await Promise.all([this.readBudgets(), this.readReservation(id)]);
    const entry = claimed.record;
    if (entry.state === "settled") throw new Error("Budget reservation was already settled");
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
    if (claimed.record.state === "settled") throw new Error("Budget reservation was already settled");
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
