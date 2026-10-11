import { z } from "zod";

import { defaults } from "../config.js";
import { FirestoreMetadataStore } from "./firestore-metadata.js";
import type { FirestoreMetadataOptions } from "./firestore-metadata.js";

const recordSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  installationId: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  requestCount: z.number().int().nonnegative(),
  maxRequests: z.number().int().min(1).max(defaults.hostedMaxRequests),
  maxCostUsd: z.number().finite().positive(),
  spentUsd: z.number().finite().nonnegative(),
  usageUnknown: z.boolean(),
  lastStatus: z.enum(["registered", "accepted", "rejected", "blocked"]),
}).strict().refine(record => record.requestCount <= record.maxRequests &&
  Date.parse(record.createdAt) < Date.parse(record.expiresAt), "Invalid run bounds");
export const HostedAgentRunSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  modelFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  inFlight: z.boolean(),
  record: recordSchema,
}).strict().refine(run => run.runId === run.record.runId &&
  (!run.inFlight || run.record.requestCount > 0), "Invalid authorization identity");

export type HostedRunRecord = z.infer<typeof recordSchema>;
export type HostedAgentRun = z.infer<typeof HostedAgentRunSchema>;

export interface HostedAgentRunStore {
  get(runId: string): Promise<HostedAgentRun | undefined>;
  insert(run: HostedAgentRun): Promise<HostedAgentRun>;
  update(runId: string, modify: (current: HostedAgentRun) => HostedAgentRun): Promise<HostedAgentRun>;
  records(): Promise<HostedAgentRun[]>;
}

function authorizeUpdate(before: HostedAgentRun, input: HostedAgentRun): HostedAgentRun {
  const after = HostedAgentRunSchema.parse(input);
  const immutable = (run: HostedAgentRun) => JSON.stringify({
    ...run, inFlight: false,
    record: { ...run.record, requestCount: 0, spentUsd: 0, usageUnknown: false, lastStatus: "registered" },
  });
  if (immutable(before) !== immutable(after) || after.record.requestCount < before.record.requestCount ||
    after.record.spentUsd < before.record.spentUsd || (before.record.usageUnknown && !after.record.usageUnknown)) {
    throw new Error("Run identity, authorization and cumulative usage cannot be changed");
  }
  return after;
}

/** Explicit local/test implementation; production selects a durable store. */
export class InMemoryHostedAgentRunStore implements HostedAgentRunStore {
  private readonly runs = new Map<string, HostedAgentRun>();

  get(runId: string): Promise<HostedAgentRun | undefined> {
    return Promise.resolve(structuredClone(this.runs.get(runId)));
  }

  insert(input: HostedAgentRun): Promise<HostedAgentRun> {
    return Promise.resolve().then(() => {
      const run = HostedAgentRunSchema.parse(input);
      if (this.runs.has(run.runId)) throw new Error("Run identity already registered");
      this.runs.set(run.runId, structuredClone(run));
      return structuredClone(run);
    });
  }

  update(runId: string, modify: (current: HostedAgentRun) => HostedAgentRun): Promise<HostedAgentRun> {
    return Promise.resolve().then(() => {
      const current = this.runs.get(runId);
      if (!current) throw new Error("Run record is absent");
      const updated = authorizeUpdate(current, modify(structuredClone(current)));
      this.runs.set(runId, structuredClone(updated));
      return structuredClone(updated);
    });
  }

  records(): Promise<HostedAgentRun[]> {
    return Promise.resolve([...this.runs.values()].map(run => structuredClone(run)));
  }
}

/** Token hashes and atomic request claims survive restarts; raw tokens/context never persist. */
export class FirestoreHostedAgentRunStore implements HostedAgentRunStore {
  private readonly documents: FirestoreMetadataStore<HostedAgentRun>;

  constructor(options: FirestoreMetadataOptions) {
    this.documents = new FirestoreMetadataStore(options, HostedAgentRunSchema);
  }

  get(runId: string): Promise<HostedAgentRun | undefined> { return this.documents.get(runId); }
  insert(run: HostedAgentRun): Promise<HostedAgentRun> { return this.documents.insert(run); }
  records(): Promise<HostedAgentRun[]> { return this.documents.records(); }
  update(runId: string, modify: (current: HostedAgentRun) => HostedAgentRun): Promise<HostedAgentRun> {
    return this.documents.update(runId, current => authorizeUpdate(current, modify(structuredClone(current))));
  }
}
