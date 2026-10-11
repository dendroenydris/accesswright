import { z } from "zod";
import { FirestoreMetadataStore } from "./firestore-metadata.js";
import type { FirestoreMetadataOptions } from "./firestore-metadata.js";
import type { GcsHostedCandidateStore, HostedCandidateReference } from "./gcs-candidate-store.js";

const referenceSchema = z.object({ generation: z.string().regex(/^[1-9][0-9]{0,19}$/), expiresAt: z.iso.datetime(), candidateDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const receiptSchema = referenceSchema.extend({ runId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), status: z.enum(["pending", "cleared"]), clearedAt: z.iso.datetime().nullable() }).strict()
  .refine(value => (value.status === "cleared") === (value.clearedAt !== null), "Cleanup status and confirmation must agree");
export type HostedCandidateCleanupReceipt = z.infer<typeof receiptSchema>;
class CandidateCleanupIdentityConflict extends Error {
  constructor() { super("Private cleanup identity changed after first registration"); }
}

/** Trusted deletion metadata only. A cleanup receipt never grants patch or PR verification authority. */
export class FirestoreCandidateCleanupStore {
  private readonly documents: FirestoreMetadataStore<HostedCandidateCleanupReceipt>;
  constructor(options: FirestoreMetadataOptions) { this.documents = new FirestoreMetadataStore(options, receiptSchema); }
  async get(runId: string): Promise<HostedCandidateCleanupReceipt | undefined> { return this.documents.get(receiptSchema.shape.runId.parse(runId)); }
  async claim(rawRunId: string, input: HostedCandidateReference): Promise<HostedCandidateCleanupReceipt> {
    const runId = receiptSchema.shape.runId.parse(rawRunId), reference = referenceSchema.parse(input);
    const existing = await this.get(runId);
    if (existing) {
      if (existing.generation !== reference.generation || existing.candidateDigest !== reference.candidateDigest || existing.expiresAt !== reference.expiresAt) {
        throw new CandidateCleanupIdentityConflict();
      }
      return existing;
    }
    return this.documents.insert({ runId, ...reference, status: "pending", clearedAt: null });
  }
  async confirm(rawRunId: string, generation: string): Promise<HostedCandidateCleanupReceipt> {
    const runId = receiptSchema.shape.runId.parse(rawRunId), expected = referenceSchema.shape.generation.parse(generation);
    return this.documents.update(runId, current => {
      if (current.generation !== expected) throw new Error("Private cleanup generation changed");
      return current.status === "cleared" ? current : { ...current, status: "cleared", clearedAt: new Date().toISOString() };
    });
  }
}

/** Safe metadata recovery can repeat deletion of the fixed generation, never a model call or verification. */
export async function clearHostedCandidate(options: {
  store: Pick<GcsHostedCandidateStore, "remove">;
  cleanup: Pick<FirestoreCandidateCleanupStore, "claim" | "confirm">;
}, rawRunId: string, input: HostedCandidateReference): Promise<void> {
  const runId = receiptSchema.shape.runId.parse(rawRunId), reference = referenceSchema.parse(input);
  try { await options.cleanup.claim(runId, reference); }
  catch (error) {
    if (error instanceof CandidateCleanupIdentityConflict) throw error;
    await options.store.remove(runId, reference.generation);
    throw error;
  }
  await options.store.remove(runId, reference.generation);
  await options.cleanup.confirm(runId, reference.generation);
}
