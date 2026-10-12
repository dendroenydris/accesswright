import { createHash } from "node:crypto";
import { z } from "zod";
import { FirestoreMetadataStore } from "./firestore-metadata.js";
import type { FirestoreMetadataOptions } from "./firestore-metadata.js";
import type { QueuedRun, WebhookRunRegistry } from "./webhook.js";

const runSchema = z.object({ runId: z.string().regex(/^[a-f0-9]{32}$/), repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  installationId: z.number().int().positive(), event: z.enum(["installation", "issue_comment"]), createdAt: z.iso.datetime(),
  pullNumber: z.number().int().positive().nullable() }).strict();
const receiptSchema = z.object({ runId: z.string().regex(/^[a-f0-9]{64}$/), delivery: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["claimed", "queued", "requires-reconciliation"]), run: runSchema.nullable() }).strict();
type Receipt = z.infer<typeof receiptSchema>;
function receiptId(key: string): string {
  return createHash("sha256").update(z.string().min(1).max(512).regex(/^[^\p{Cc}]+$/u).parse(key)).digest("hex");
}

/** Unknown queue replies retain their original claim across restarts; only a confirmed enqueue is a duplicate. */
export class FirestoreWebhookRunRegistry implements WebhookRunRegistry {
  private readonly metadata: FirestoreMetadataStore<Receipt>;
  constructor(options: FirestoreMetadataOptions) { this.metadata = new FirestoreMetadataStore(options, receiptSchema); }

  async claim(key: string, rawDelivery: string): Promise<boolean> {
    const runId = receiptId(key), delivery = receiptSchema.shape.delivery.parse(rawDelivery);
    try { await this.metadata.insert({ runId, delivery, status: "claimed", run: null }); return true; }
    catch (error) {
      if (!(error instanceof Error) || !/conflict|already exists/i.test(error.message)) throw error;
      const existing = await this.metadata.get(runId);
      if (!existing || existing.status !== "queued" || existing.run?.runId !== runId.slice(0, 32)) throw new Error("Webhook enqueue requires reconciliation", { cause: error });
      return false;
    }
  }

  async commit(key: string, input: QueuedRun): Promise<void> {
    const runId = receiptId(key), run = runSchema.parse(input);
    if (run.runId !== runId.slice(0, 32)) throw new Error("Webhook run identity changed");
    await this.metadata.update(runId, current => {
      if (current.status === "queued" && JSON.stringify(current.run) === JSON.stringify(run)) return current;
      if (current.status !== "claimed" || current.run !== null) throw new Error("Webhook enqueue claim changed");
      return { ...current, status: "queued", run };
    });
  }

  async release(key: string, delivery: string): Promise<void> {
    await this.metadata.update(receiptId(key), current => {
      if (current.delivery !== delivery) throw new Error("Webhook delivery claim changed");
      // A transport error can follow a successful enqueue: never delete or recycle this claim.
      return current.status === "claimed" ? { ...current, status: "requires-reconciliation" } : current;
    });
  }
}
