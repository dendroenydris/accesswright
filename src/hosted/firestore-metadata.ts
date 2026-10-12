import { z } from "zod";

import { defaults } from "../config.js";

const projectSchema = z.string().regex(/^[a-z][a-z0-9-]{4,30}[a-z0-9]$/, "Invalid Firestore project identifier");
const databaseSchema = z.union([z.literal("(default)"), z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/)]);
const collectionSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/);
const runIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const documentSchema = z.object({
  updateTime: z.string().min(10).max(60).regex(/^[0-9TZ.:+-]+$/),
  fields: z.object({
    payload: z.object({ stringValue: z.string().max(defaults.firestoreRecordMaxBytes) }).passthrough(),
  }).passthrough(),
}).passthrough();
const pageSchema = z.object({
  documents: z.array(documentSchema).max(defaults.firestorePageSize).optional(),
  nextPageToken: z.string().max(4096).optional(),
}).passthrough();

export interface FirestoreMetadataOptions {
  projectId: string;
  databaseId?: string;
  collectionId: string;
  /** Trusted workload identity only; never supplied by target repository code. */
  getAccessToken: () => Promise<string>;
  fetcher?: typeof fetch;
}

interface FirestoreWrite<T> { record: T; updateTime: string | null }

async function boundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length") ?? 0) > defaults.firestoreResponseMaxBytes) {
    await response.body?.cancel();
    throw new Error("Firestore response exceeds metadata size limit");
  }
  if (!response.body) throw new Error("Firestore omitted the metadata response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > defaults.firestoreResponseMaxBytes) {
        await reader.cancel();
        throw new Error("Firestore response exceeds metadata size limit");
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Bounded metadata documents with create-only insertion and updateTime compare-and-swap. */
export class FirestoreMetadataStore<T extends { runId: string }> {
  private readonly documentsUrl: string;
  private readonly collectionUrl: string;
  private readonly schema: z.ZodType<T>;
  private readonly options: FirestoreMetadataOptions;

  constructor(options: FirestoreMetadataOptions, schema: z.ZodType<T>) {
    this.options = options;
    this.schema = schema;
    const project = projectSchema.parse(options.projectId);
    const database = databaseSchema.parse(options.databaseId ?? "(default)");
    const collection = collectionSchema.parse(options.collectionId);
    this.documentsUrl = "https://firestore.googleapis.com/v1/projects/" + project +
      "/databases/" + encodeURIComponent(database) + "/documents";
    this.collectionUrl = this.documentsUrl + "/" + collection;
  }

  private decode(input: unknown, expectedId?: string): { record: T; updateTime: string } {
    const doc = documentSchema.parse(input);
    const record = this.schema.parse(JSON.parse(doc.fields.payload.stringValue) as unknown);
    runIdSchema.parse(record.runId);
    if (expectedId !== undefined && record.runId !== expectedId) {
      throw new Error("Firestore returned mismatched run identity");
    }
    return { record, updateTime: doc.updateTime };
  }

  private async request(method: "GET" | "POST" | "PATCH", path: string, record?: T): Promise<Response> {
    const token = await this.options.getAccessToken();
    if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error("Firestore workload identity token is unavailable");
    const payload = record === undefined ? undefined : JSON.stringify(record);
    if (payload !== undefined && Buffer.byteLength(payload) > defaults.firestoreRecordMaxBytes) {
      throw new Error("Firestore record exceeds metadata size limit");
    }
    return (this.options.fetcher ?? fetch)(this.collectionUrl + path, {
      method, redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify({ fields: { payload: { stringValue: payload } } }) }),
    });
  }

  private async read(runId: string): Promise<{ record: T; updateTime: string } | undefined> {
    const id = runIdSchema.parse(runId);
    const response = await this.request("GET", "/" + encodeURIComponent(id));
    if (response.status === 404) { await response.body?.cancel(); return undefined; }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Firestore metadata read failed (HTTP " + response.status + ")");
    }
    return this.decode(await boundedJson(response), id);
  }

  async get(runId: string): Promise<T | undefined> {
    const doc = await this.read(runId);
    return doc === undefined ? undefined : structuredClone(doc.record);
  }

  async getVersion(runId: string): Promise<{ record: T; updateTime: string } | undefined> {
    return structuredClone(await this.read(runId));
  }

  /** All records change together, or none does; null versions are create-only. */
  async commit(changes: readonly FirestoreWrite<T>[]): Promise<void> {
    if (changes.length < 2 || changes.length > defaults.firestoreMaxAtomicRecords ||
      new Set(changes.map(change => change.record.runId)).size !== changes.length) throw new Error("Atomic metadata writes require bounded distinct records");
    const writes = changes.map(change => {
      const record = this.schema.parse(change.record);
      const id = runIdSchema.parse(record.runId);
      const payload = JSON.stringify(record);
      if (Buffer.byteLength(payload) > defaults.firestoreRecordMaxBytes) throw new Error("Firestore record exceeds metadata size limit");
      const updateTime = change.updateTime === null ? null : documentSchema.shape.updateTime.parse(change.updateTime);
      return {
        update: { name: this.collectionUrl.slice("https://firestore.googleapis.com/v1/".length) + "/" + id,
          fields: { payload: { stringValue: payload } } },
        ...(updateTime === null ? {} : { updateMask: { fieldPaths: ["payload"] } }),
        currentDocument: updateTime === null ? { exists: false } : { updateTime },
      };
    });
    const token = await this.options.getAccessToken();
    if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error("Firestore workload identity token is unavailable");
    const response = await (this.options.fetcher ?? fetch)(this.documentsUrl + ":commit", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ writes }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Firestore atomic metadata commit failed (HTTP " + response.status + ")");
    }
    const written = z.object({ updateTime: documentSchema.shape.updateTime }).passthrough();
    z.object({ writeResults: z.array(written).length(changes.length), commitTime: documentSchema.shape.updateTime }).passthrough()
      .parse(await boundedJson(response));
  }

  async insert(input: T): Promise<T> {
    const record = this.schema.parse(input);
    const id = runIdSchema.parse(record.runId);
    const response = await this.request("POST", "?documentId=" + encodeURIComponent(id), record);
    return this.saved(response, record, "create");
  }

  async update(runId: string, modify: (current: T) => T): Promise<T> {
    const current = await this.read(runId);
    if (!current) throw new Error("Firestore run record is absent");
    const updated = this.schema.parse(modify(structuredClone(current.record)));
    if (updated.runId !== current.record.runId) throw new Error("Run identity cannot be changed");
    const response = await this.request("PATCH", "/" + encodeURIComponent(updated.runId) +
      "?updateMask.fieldPaths=payload&currentDocument.updateTime=" + encodeURIComponent(current.updateTime), updated);
    return this.saved(response, updated, "update");
  }

  private async saved(response: Response, record: T, operation: string): Promise<T> {
    if (response.status === 409 || response.status === 412) {
      await response.body?.cancel();
      throw new Error("Firestore concurrent update conflict or run record already exists");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Firestore metadata " + operation + " failed (HTTP " + response.status + ")");
    }
    const saved = this.decode(await boundedJson(response), record.runId).record;
    if (JSON.stringify(saved) !== JSON.stringify(record)) throw new Error("Firestore response differs from submitted metadata");
    return structuredClone(saved);
  }

  async records(): Promise<T[]> {
    const records: T[] = [];
    const seen = new Set<string>();
    const seenRunIds = new Set<string>();
    let token = "";
    for (let page = 0; page < defaults.firestoreMaxListPages; page += 1) {
      const response = await this.request("GET", "?pageSize=" + defaults.firestorePageSize +
        (token ? "&pageToken=" + encodeURIComponent(token) : ""));
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Firestore metadata list failed (HTTP " + response.status + ")");
      }
      const result = pageSchema.parse(await boundedJson(response));
      for (const doc of result.documents ?? []) {
        const record = this.decode(doc).record;
        if (seenRunIds.has(record.runId)) throw new Error("Duplicate Firestore run identity");
        seenRunIds.add(record.runId);
        records.push(record);
      }
      token = result.nextPageToken ?? "";
      if (!token) return records;
      if (seen.has(token)) throw new Error("Firestore repeated a pagination token");
      seen.add(token);
    }
    throw new Error("Firestore metadata listing exceeds page limit");
  }
}
