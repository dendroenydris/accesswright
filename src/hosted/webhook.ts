import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const MAX_WEBHOOK_BYTES = 1_048_576;
const DeliverySchema = z.string().uuid();
const FullNameSchema = z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);

export interface WebhookHeaders {
  "x-hub-signature-256"?: string;
  "x-github-event"?: string;
  "x-github-delivery"?: string;
}

/** Verify raw transport bytes before parsing, with bounded work and constant-time digest comparison. */
export function verifyGitHubSignature(body: Uint8Array, signature: string | undefined, secret: string): boolean {
  if (body.byteLength > MAX_WEBHOOK_BYTES) throw new Error("Webhook body exceeds size limit");
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const provided = Buffer.from(signature.slice(7), "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

const CommonPayloadSchema = z.object({
  installation: z.object({ id: z.number().int().positive() }).passthrough(),
  repository: z.object({ full_name: FullNameSchema, private: z.boolean() }).passthrough(),
  sender: z.object({ login: z.string().min(1).max(100) }).passthrough(),
  action: z.string().min(1),
}).passthrough();

export interface QueuedRun {
  runId: string;
  repository: string;
  installationId: number;
  event: "installation" | "issue_comment";
  createdAt: string;
  pullNumber: number | null;
}

export interface WebhookDispatchResult {
  status: "queued" | "ignored" | "duplicate" | "unauthorized";
  runId: string | null;
}

export interface WebhookDispatchDependencies {
  secret: string;
  installationAllowlist: ReadonlySet<number>;
  registry: InMemoryRunRegistry;
  queue: (run: QueuedRun) => Promise<void>;
  authorizeComment: (context: {
    repository: string; pullNumber: number; sender: string; installationId: number;
  }) => Promise<boolean>;
}

/** In-process adapter for local integration; production must use a durable compare-and-set store. */
export class InMemoryRunRegistry {
  private readonly committed = new Map<string, QueuedRun>();
  private readonly claimed = new Set<string>();
  private readonly deliveries = new Set<string>();

  claim(key: string, delivery: string): boolean {
    if (this.committed.has(key) || this.claimed.has(key) || this.deliveries.has(delivery)) return false;
    this.claimed.add(key);
    this.deliveries.add(delivery);
    return true;
  }

  commit(key: string, run: QueuedRun): void {
    if (!this.claimed.has(key)) throw new Error("Attempted to commit unclaimed webhook run");
    this.committed.set(key, { ...run });
    this.claimed.delete(key);
  }

  release(key: string, delivery: string): void {
    this.claimed.delete(key);
    this.deliveries.delete(delivery);
  }

  list(): QueuedRun[] {
    return [...this.committed.values()].map(item => ({ ...item }));
  }
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function dispatchGitHubWebhook(
  body: Uint8Array,
  headers: WebhookHeaders,
  dependencies: WebhookDispatchDependencies,
): Promise<WebhookDispatchResult> {
  if (!verifyGitHubSignature(body, headers["x-hub-signature-256"], dependencies.secret)) {
    return { status: "unauthorized", runId: null };
  }
  const delivery = DeliverySchema.parse(headers["x-github-delivery"]);
  const event = headers["x-github-event"];
  if (event !== "installation" && event !== "issue_comment") {
    return { status: "ignored", runId: null };
  }
  const payload = CommonPayloadSchema.parse(JSON.parse(Buffer.from(body).toString("utf8")) as unknown);
  if (!dependencies.installationAllowlist.has(payload.installation.id)) {
    return { status: "unauthorized", runId: null };
  }

  let key: string;
  let pullNumber: number | null = null;
  if (event === "installation") {
    if (payload.action !== "created") return { status: "ignored", runId: null };
    key = "installation|" + payload.installation.id + "|" + payload.repository.full_name;
  } else {
    if (payload.action !== "created") return { status: "ignored", runId: null };
    const comment = z.object({
      issue: z.object({
        number: z.number().int().positive(),
        pull_request: z.object({}).passthrough(),
      }).passthrough(),
      comment: z.object({ body: z.string().max(20_000), id: z.number().int().positive() }).passthrough(),
    }).parse(payload);
    if (comment.comment.body.trim() !== "/accesswright fix") {
      return { status: "ignored", runId: null };
    }
    pullNumber = comment.issue.number;
    if (!await dependencies.authorizeComment({
      repository: payload.repository.full_name,
      pullNumber,
      sender: payload.sender.login,
      installationId: payload.installation.id,
    })) {
      return { status: "unauthorized", runId: null };
    }
    key = "comment|" + payload.installation.id + "|" + payload.repository.full_name + "|" + comment.comment.id;
  }

  const deliveryKey = stableId(delivery);
  const runId = stableId(key).slice(0, 32);
  if (!dependencies.registry.claim(key, deliveryKey)) {
    return { status: "duplicate", runId };
  }

  const run: QueuedRun = {
    runId,
    repository: payload.repository.full_name,
    installationId: payload.installation.id,
    event,
    createdAt: new Date().toISOString(),
    pullNumber,
  };
  try {
    await dependencies.queue(run);
    dependencies.registry.commit(key, run);
    return { status: "queued", runId };
  } catch (error) {
    dependencies.registry.release(key, deliveryKey);
    throw error;
  }
}
