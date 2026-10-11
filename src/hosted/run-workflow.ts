import { createHash } from "node:crypto";
import { z } from "zod";

import { RunReportSchema } from "../reporter/report.js";
import type { RunReport } from "../reporter/report.js";

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const runSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const repoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

export interface StoredRunResult {
  runId: string;
  repository: string;
  installationId: number;
  reportDigest: string;
  status: "recorded" | "verifying" | "blocked" | "ready-for-review";
  acceptedFixes: number;
  /** Computed after full schema and production gate inspection; raw report is not stored. */
  eligibleForReview: boolean;
  failedChecks: string[];
  unknownUsage: boolean;
  spentUsd: number;
  verifiedBaseSha: string | null;
  recordedAt: string;
}

export interface HostedRunStore {
  get(runId: string): StoredRunResult | undefined | Promise<StoredRunResult | undefined>;
  insert(record: StoredRunResult): StoredRunResult | Promise<StoredRunResult>;
  update(runId: string, modify: (current: StoredRunResult) => StoredRunResult): StoredRunResult | Promise<StoredRunResult>;
}

export function ensureHostedRunUpdate(before: StoredRunResult, after: StoredRunResult): void {
  const identity = (record: StoredRunResult) => JSON.stringify({ ...record, status: "recorded", verifiedBaseSha: null });
  if (identity(before) !== identity(after)) throw new Error("Run identity and immutable verification metadata cannot be changed");
  if ((before.status === "blocked" || before.status === "ready-for-review") &&
    (after.status !== before.status || after.verifiedBaseSha !== before.verifiedBaseSha)) throw new Error("Terminal run state cannot be changed");
  if (before.status === "verifying" && after.status === "recorded") throw new Error("Verification claim cannot be released without trusted reconciliation");
}

/**
 * Local-only store. Cloud deployment needs Firestore transactional backing;
 * do not treat in-memory records as durable across service restarts.
 */
export class InMemoryHostedRunStore implements HostedRunStore {
  private readonly records = new Map<string, StoredRunResult>();

  get(runId: string): StoredRunResult | undefined {
    const value = this.records.get(runId);
    return value === undefined ? undefined : structuredClone(value);
  }

  insert(record: StoredRunResult): StoredRunResult {
    if (this.records.has(record.runId)) throw new Error("Run record already exists");
    this.records.set(record.runId, structuredClone(record));
    return structuredClone(record);
  }

  update(runId: string, modify: (current: StoredRunResult) => StoredRunResult): StoredRunResult {
    const current = this.records.get(runId);
    if (current === undefined) throw new Error("Run record is absent");
    const updated = modify(structuredClone(current));
    ensureHostedRunUpdate(current, updated);
    this.records.set(runId, structuredClone(updated));
    return structuredClone(updated);
  }
}

export interface TrustedRunReceipt {
  /** SHA-256 of the exact aggregate report independently checked by a trusted verifier. */
  reportDigest: string;
  verifiedBaseSha: string;
}

export interface HostedRunWorkflowDependencies {
  store: HostedRunStore;
  authenticate: (runId: string, token: string) => {
    runId: string;
    repository: string;
    installationId: number;
  } | Promise<{ runId: string; repository: string; installationId: number }>;
  /** Must run in the *trusted* coordinator boundary, not in target repo code. */
  verifyTrustedResult: (runId: string, reportDigest: string) => Promise<TrustedRunReceipt | null>;
}

export function hostedReportDigest(report: RunReport): string {
  return createHash("sha256").update(JSON.stringify(RunReportSchema.parse(report))).digest("hex");
}

export function eligibleForTrustedVerification(report: RunReport): boolean {
  const checks = ["build", "typecheck", "lint", "tests"];
  const results = report.checks;
  const checked = checks.every(required => {
    const found = results.filter(item => item.check === required);
    return found.length === 1 && found[0]?.available === true && found[0].status === "passed" &&
      found[0].exitCode === 0 && found[0].failureIds.length === 0;
  });
  const accepted = report.final.acceptedFixIds;
  const finished = report.outcomes.filter(item => item.status === "verified").map(item => item.id);
  return report.status === "verified" && !report.unknownUsage &&
    report.final.failures.length === 0 && checked &&
    new Set(accepted).size === accepted.length &&
    new Set(finished).size === finished.length && report.fixed === accepted.length &&
    accepted.length === finished.length && accepted.every(id => finished.includes(id));
}

export interface HostedRunTransition {
  status: StoredRunResult["status"];
  runId: string;
  verifiedBaseSha?: string;
}

/** Untrusted job aggregates are metadata only, never PR-publishing authority. */
export class HostedRunWorkflow {
  private readonly dependencies: HostedRunWorkflowDependencies;

  constructor(dependencies: HostedRunWorkflowDependencies) {
    this.dependencies = dependencies;
  }

  private async authenticate(runId: string, token: string): Promise<Awaited<ReturnType<HostedRunWorkflowDependencies["authenticate"]>>> {
    const parsed = runSchema.parse(runId);
    const identity = await this.dependencies.authenticate(parsed, token);
    if (identity.runId !== parsed) throw new Error("Run authorization identity mismatch");
    return {
      runId: parsed,
      repository: repoSchema.parse(identity.repository),
      installationId: z.number().int().positive().parse(identity.installationId),
    };
  }

  async submitResults(runId: string, token: string, raw: unknown): Promise<HostedRunTransition> {
    const identity = await this.authenticate(runId, token);
    const report = RunReportSchema.parse(raw);
    const reportDigest = hostedReportDigest(report);
    const existing = await this.dependencies.store.get(identity.runId);
    if (existing) {
      if (existing.reportDigest !== reportDigest ||
        existing.installationId !== identity.installationId ||
        existing.repository !== identity.repository) throw new Error("Conflicting run report changed after first submission");
      return { runId, status: existing.status };
    }
    const failedChecks = report.checks.filter(check => check.status !== "passed" || !check.available)
      .map(check => check.check);
    const stored = await this.dependencies.store.insert({
      ...identity,
      reportDigest,
      status: "recorded",
      acceptedFixes: report.final.acceptedFixIds.length,
      eligibleForReview: eligibleForTrustedVerification(report),
      failedChecks,
      unknownUsage: report.unknownUsage,
      spentUsd: report.usage.spentUsd,
      verifiedBaseSha: null,
      recordedAt: new Date().toISOString(),
    });
    // The raw report, original target reasons and snippets are never retained.
    // A durable store can retain this minimal metadata safely.
    return { runId, status: stored.status };
  }

  async inspect(runId: string, token: string): Promise<StoredRunResult | undefined> {
    const identity = await this.authenticate(runId, token);
    const stored = await this.dependencies.store.get(runId);
    return stored?.repository === identity.repository && stored?.installationId === identity.installationId
      ? stored : undefined;
  }

  async finish(runId: string, token: string): Promise<HostedRunTransition> {
    const identity = await this.authenticate(runId, token);
    const current = await this.dependencies.store.get(identity.runId);
    if (current === undefined || current.repository !== identity.repository ||
      current.installationId !== identity.installationId) {
      throw new Error("Run results must be submitted before finish");
    }
    if (current.status === "ready-for-review") {
      return { runId, status: current.status, ...(current.verifiedBaseSha ? { verifiedBaseSha: current.verifiedBaseSha } : {}) };
    }
    if (current.status === "blocked") return { runId, status: "blocked" };
    if (current.status === "verifying") throw new Error("Trusted verification is already in progress; interrupted work needs trusted reconciliation");

    let claimed = false;
    await this.dependencies.store.update(runId, record => {
      claimed = record.status === "recorded";
      return claimed ? { ...record, status: "verifying" } : record;
    });
    if (!claimed) throw new Error("Trusted verification is already in progress");

    // Client-submitted report flags never authorize a PR: the trusted verifier
    // must independently confirm the exact digest before review can proceed.
    let trusted: TrustedRunReceipt | null = null;
    if (current.eligibleForReview) {
      trusted = await this.dependencies.verifyTrustedResult(runId, current.reportDigest);
    }
    const validReceipt = trusted !== null &&
      trusted.reportDigest === current.reportDigest &&
      shaSchema.safeParse(trusted.verifiedBaseSha).success;
    const updated = await this.dependencies.store.update(runId, record => {
      if (record.status !== "verifying") throw new Error("Trusted verification claim changed");
      return { ...record, status: validReceipt ? "ready-for-review" : "blocked",
        verifiedBaseSha: validReceipt && trusted !== null ? trusted.verifiedBaseSha : null };
    });
    return { runId, status: updated.status, ...(updated.verifiedBaseSha ? { verifiedBaseSha: updated.verifiedBaseSha } : {}) };
  }
}
