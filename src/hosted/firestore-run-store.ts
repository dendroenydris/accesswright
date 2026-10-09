import { z } from "zod";

import type { HostedRunStore, StoredRunResult } from "./run-workflow.js";

const projectSchema = z.string().regex(/^[a-z][a-z0-9-]{4,30}[a-z0-9]$/, "Invalid Firestore project identifier");
const databaseSchema = z.union([z.literal("(default)"), z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/)]);
const collectionSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/);
const runIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = z.object({
  runId: runIdSchema,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  installationId: z.number().int().positive(),
  reportDigest: digestSchema,
  status: z.enum(["recorded", "blocked", "ready-for-review"]),
  acceptedFixes: z.number().int().nonnegative().max(200),
  eligibleForReview: z.boolean(),
  failedChecks: z.array(z.enum(["build", "typecheck", "lint", "tests"])).max(4),
  unknownUsage: z.boolean(),
  spentUsd: z.number().finite().nonnegative(),
  verifiedBaseSha: shaSchema.nullable(),
  recordedAt: z.iso.datetime(),
}).strict();

const responseDocument = z.object({
  updateTime: z.string().min(10).max(60).regex(/^[0-9TZ.:+-]+$/),
  fields: z.object({
    payload: z.object({ stringValue: z.string().max(8192) }).passthrough(),
  }).passthrough(),
}).passthrough();

export interface FirestoreHostedRunStoreOptions {
  projectId: string;
  databaseId?: string;
  collectionId: string;
  /** Token from the trusted service's workload identity; never from target repository code. */
  getAccessToken: () => Promise<string>;
  fetcher?: typeof fetch;
}

interface FirestoreDocument {
  record: StoredRunResult;
  updateTime: string;
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > 20000) {
    await response.body?.cancel();
    throw new Error("Firestore response exceeds metadata size limit");
  }
  if (!response.body) throw new Error("Firestore omitted the metadata response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > 20000) {
        await reader.cancel();
        throw new Error("Firestore response exceeds metadata size limit");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function decodeDocument(input: unknown, runId: string): FirestoreDocument {
  const doc = responseDocument.parse(input);
  const record = recordSchema.parse(JSON.parse(doc.fields.payload.stringValue) as unknown);
  if (record.runId !== runId) throw new Error("Firestore returned mismatched run identity");
  return { record, updateTime: doc.updateTime };
}

function ensureMetadataOnlyUpdate(before: StoredRunResult, after: StoredRunResult): void {
  const identity = (record: StoredRunResult) => JSON.stringify({
    ...record,
    status: "recorded",
    verifiedBaseSha: null,
  });
  if (identity(before) !== identity(after) || after.runId !== before.runId) {
    throw new Error("Run identity and immutable verification metadata cannot be changed");
  }
  if (before.status !== "recorded" && (after.status !== before.status ||
    after.verifiedBaseSha !== before.verifiedBaseSha)) {
    throw new Error("Terminal run state cannot be changed");
  }
}

/**
 * Firestore REST implementation using create-only insertion and conditional
 * updateTime compare-and-swap. No client-side write retries and no raw run
 * reports/source/prompts persisted. Deployment supplies a trusted identity
 * token, Firestore IAM and private service ingress.
 */
export class FirestoreHostedRunStore implements HostedRunStore {
  private readonly collectionUrl: string;
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetcher: typeof fetch;

  constructor(options: FirestoreHostedRunStoreOptions) {
    const project = projectSchema.parse(options.projectId);
    const database = databaseSchema.parse(options.databaseId ?? "(default)");
    const collection = collectionSchema.parse(options.collectionId);
    this.collectionUrl = "https://firestore.googleapis.com/v1/projects/" +
      project + "/databases/" + encodeURIComponent(database) + "/documents/" + collection;
    this.getAccessToken = options.getAccessToken;
    this.fetcher = options.fetcher ?? fetch;
  }

  private async request(method: "GET" | "POST" | "PATCH", path: string, data?: StoredRunResult): Promise<Response> {
    const token = await this.getAccessToken();
    if (!token || token.length > 4096 || /[\r\n]/.test(token)) {
      throw new Error("Firestore workload identity token is unavailable");
    }
    const response = await this.fetcher(this.collectionUrl + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      ...(data === undefined ? {} : {
        body: JSON.stringify({ fields: { payload: { stringValue: JSON.stringify(data) } } }),
      }),
    });
    return response;
  }

  private async read(runId: string): Promise<FirestoreDocument | undefined> {
    const id = runIdSchema.parse(runId);
    const response = await this.request("GET", "/" + encodeURIComponent(id));
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Firestore metadata read failed (HTTP " + response.status + ")");
    }
    return decodeDocument(await boundedJson(response), id);
  }

  async get(runId: string): Promise<StoredRunResult | undefined> {
    const doc = await this.read(runId);
    return doc === undefined ? undefined : structuredClone(doc.record);
  }

  async insert(raw: StoredRunResult): Promise<StoredRunResult> {
    const record = recordSchema.parse(raw);
    const response = await this.request("POST", "?documentId=" + encodeURIComponent(record.runId), record);
    if (response.status === 409 || response.status === 412) {
      await response.body?.cancel();
      throw new Error("Firestore run record already exists or conflicts");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Firestore metadata create failed (HTTP " + response.status + ")");
    }
    const created = decodeDocument(await boundedJson(response), record.runId).record;
    if (JSON.stringify(created) !== JSON.stringify(record)) {
      throw new Error("Firestore create response differs from submitted metadata");
    }
    return structuredClone(created);
  }

  async update(
    runId: string,
    modify: (current: StoredRunResult) => StoredRunResult,
  ): Promise<StoredRunResult> {
    const current = await this.read(runId);
    if (!current) throw new Error("Firestore run record is absent");
    const updated = recordSchema.parse(modify(structuredClone(current.record)));
    ensureMetadataOnlyUpdate(current.record, updated);
    if (updated.status === "ready-for-review" && updated.verifiedBaseSha === null) {
      throw new Error("A verified base SHA is required for ready-for-review");
    }
    const query = "?updateMask.fieldPaths=payload&currentDocument.updateTime=" +
      encodeURIComponent(current.updateTime);
    const response = await this.request("PATCH", "/" + encodeURIComponent(current.record.runId) + query, updated);
    if (response.status === 404 || response.status === 409 || response.status === 412) {
      await response.body?.cancel();
      throw new Error("Firestore concurrent update conflict or run record missing");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Firestore metadata update failed (HTTP " + response.status + ")");
    }
    const recorded = decodeDocument(await boundedJson(response), updated.runId).record;
    if (JSON.stringify(recorded) !== JSON.stringify(updated)) {
      throw new Error("Firestore update response differs from submitted metadata");
    }
    return structuredClone(recorded);
  }
}
