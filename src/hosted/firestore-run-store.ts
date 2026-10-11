import { z } from "zod";

import { FirestoreMetadataStore } from "./firestore-metadata.js";
import type { FirestoreMetadataOptions } from "./firestore-metadata.js";
import type { HostedRunStore, StoredRunResult } from "./run-workflow.js";

const recordSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  installationId: z.number().int().positive(),
  reportDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["recorded", "blocked", "ready-for-review"]),
  acceptedFixes: z.number().int().nonnegative().max(200),
  eligibleForReview: z.boolean(),
  failedChecks: z.array(z.enum(["build", "typecheck", "lint", "tests"])).max(4),
  unknownUsage: z.boolean(),
  spentUsd: z.number().finite().nonnegative(),
  verifiedBaseSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  recordedAt: z.iso.datetime(),
}).strict();

export type FirestoreHostedRunStoreOptions = FirestoreMetadataOptions;

function ensureMetadataOnlyUpdate(before: StoredRunResult, after: StoredRunResult): void {
  const identity = (record: StoredRunResult) => JSON.stringify({ ...record, status: "recorded", verifiedBaseSha: null });
  if (identity(before) !== identity(after) || after.runId !== before.runId) {
    throw new Error("Run identity and immutable verification metadata cannot be changed");
  }
  if (before.status !== "recorded" && (after.status !== before.status || after.verifiedBaseSha !== before.verifiedBaseSha)) {
    throw new Error("Terminal run state cannot be changed");
  }
}

/** Durable aggregate metadata only; authenticated jobs cannot grant themselves PR authority. */
export class FirestoreHostedRunStore implements HostedRunStore {
  private readonly documents: FirestoreMetadataStore<StoredRunResult>;

  constructor(options: FirestoreHostedRunStoreOptions) {
    this.documents = new FirestoreMetadataStore(options, recordSchema);
  }

  get(runId: string): Promise<StoredRunResult | undefined> { return this.documents.get(runId); }
  insert(record: StoredRunResult): Promise<StoredRunResult> { return this.documents.insert(record); }
  update(runId: string, modify: (current: StoredRunResult) => StoredRunResult): Promise<StoredRunResult> {
    return this.documents.update(runId, current => {
      const updated = recordSchema.parse(modify(structuredClone(current)));
      ensureMetadataOnlyUpdate(current, updated);
      if (updated.status === "ready-for-review" && updated.verifiedBaseSha === null) {
        throw new Error("A verified base SHA is required for ready-for-review");
      }
      return updated;
    });
  }
}
