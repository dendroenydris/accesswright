import { z } from "zod";
import { FirestoreMetadataStore } from "./firestore-metadata.js";
import type { FirestoreMetadataOptions } from "./firestore-metadata.js";

const identitySchema = z.object({ runId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).refine(value => value.split("/").every(part => part !== "." && part !== "..")),
  installationId: z.number().int().positive() }).strict();
const revisionSchema = identitySchema.extend({ verifiedBaseSha: z.string().regex(/^[a-f0-9]{40}$/), registeredAt: z.iso.datetime() }).strict();
type CheckoutIdentity = z.infer<typeof identitySchema>;
type PinnedCheckout = z.infer<typeof revisionSchema>;

/** Create-only original revisions survive restarts; no private source, tokens or mutable branch names persist. */
export class FirestoreHostedCheckoutRegistry {
  private readonly documents: FirestoreMetadataStore<PinnedCheckout>;
  constructor(options: FirestoreMetadataOptions) { this.documents = new FirestoreMetadataStore(options, revisionSchema); }

  async register(input: CheckoutIdentity & { verifiedBaseSha: string }): Promise<PinnedCheckout> {
    return await this.documents.insert(revisionSchema.parse({ ...input, registeredAt: new Date().toISOString() }));
  }

  async resolve(input: CheckoutIdentity): Promise<PinnedCheckout> {
    const run = identitySchema.parse(input), pin = await this.documents.get(run.runId);
    if (!pin || pin.repository !== run.repository || pin.installationId !== run.installationId) throw new Error("Original checkout identity is unconfirmed");
    return pin;
  }
}
