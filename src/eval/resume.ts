import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { RenderedCaseSchema } from "./cases.js";
import type { RenderedCase } from "./cases.js";
import { EvalProtocolSchema, EvalSystemSchema } from "./protocol.js";
import type { EvalProtocol, EvalSystem, FrozenProtocol } from "./protocol.js";
import { EvalCellSchema, aggregateEvaluation } from "./report.js";
import type { EvalCell } from "./report.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const repositorySchema = EvalProtocolSchema.shape.repositories.element;
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  protocol: z.object({ digest, protocol: EvalProtocolSchema }).strict(),
  implementationDigest: digest,
  runtimeSnapshot: z.literal("runtime"),
  selection: z.object({
    split: z.enum(["dev", "test"]),
    systems: z.array(EvalSystemSchema),
    seeds: z.array(z.number().int().nonnegative()),
    repositories: z.array(repositorySchema),
  }).strict(),
  caseLimit: z.number().int().positive(),
  providerInjection: z.boolean(),
}).passthrough();
const referenceSchema = z.object({
  repository: repositorySchema,
  rendered: z.object({
    eligible: z.array(RenderedCaseSchema),
    excluded: z.array(z.object({ id: digest, reason: z.string() }).strict()),
  }).strict(),
  implementationDigest: digest,
}).strict();

export interface EvalResumeSelection {
  split: "dev" | "test";
  systems: EvalSystem[];
  seeds: number[];
  repositories: EvalProtocol["repositories"];
}

export interface EvalResumeOptions {
  outputDir: string;
  frozen: FrozenProtocol;
  implementationDigest: string;
  selection: EvalResumeSelection;
  caseLimit: number;
  providerInjection: boolean;
}

export interface EvalReference {
  repository: EvalProtocol["repositories"][number];
  rendered: { eligible: RenderedCase[]; excluded: Array<{ id: string; reason: string }> };
  implementationDigest: string;
}

export function evalCellFileName(cell: Pick<EvalCell, "repository" | "sha" | "system" | "seed" | "batch">): string {
  const identity = cell.repository + "@" + cell.sha + "|" + cell.system + "|" + cell.seed + "|" + cell.batch;
  return createHash("sha256").update(identity).digest("hex") + ".json";
}

export function evalReferenceFileName(repository: string): string {
  return createHash("sha256").update(repository).digest("hex") + "-reference.json";
}

/** Fail closed on any mismatch. Partial cells are never re-labeled as successes. */
export async function loadEvalResumeState(options: EvalResumeOptions): Promise<{
  cells: EvalCell[];
  references: Map<string, EvalReference>;
  existingCellFiles: Set<string>;
}> {
  const raw = manifestSchema.parse(JSON.parse(await readFile(join(options.outputDir, "manifest.json"), "utf8")) as unknown);
  if (
    raw.protocol.digest !== options.frozen.digest ||
    JSON.stringify(raw.protocol.protocol) !== JSON.stringify(options.frozen.protocol) ||
    raw.implementationDigest !== options.implementationDigest ||
    JSON.stringify(raw.selection) !== JSON.stringify(options.selection) ||
    raw.caseLimit !== options.caseLimit ||
    raw.providerInjection !== options.providerInjection
  ) {
    throw new Error("Cannot resume evaluation: frozen protocol, model, implementation, selection, or case bound differs");
  }
  const files = await readdir(options.outputDir);
  if (files.includes("summary.json") || files.includes("report.md")) {
    throw new Error("Cannot resume a completed or partially published summary");
  }
  const validRepositories = new Map(options.selection.repositories.map(item => [item.repository.toLowerCase(), item]));
  const cells: EvalCell[] = [];
  const existingCellFiles = new Set<string>();
  const references = new Map<string, EvalReference>();
  for (const filename of files) {
    if (filename.startsWith("._")) continue;
    if (/^[a-f0-9]{64}\.json$/.test(filename)) {
      const cell = EvalCellSchema.parse(JSON.parse(await readFile(join(options.outputDir, filename), "utf8")) as unknown);
      const repo = validRepositories.get(cell.repository.toLowerCase());
      if (
        cell.protocolDigest !== options.frozen.digest ||
        cell.implementationDigest !== options.implementationDigest ||
        JSON.stringify(cell.model) !== JSON.stringify(options.frozen.protocol.model) ||
        cell.split !== options.selection.split ||
        repo?.sha !== cell.sha ||
        !options.selection.systems.includes(cell.system) ||
        !options.selection.seeds.includes(cell.seed) ||
        evalCellFileName(cell) !== filename
      ) {
        throw new Error("Cannot resume evaluation: persisted cell does not belong to this selection or identity");
      }
      cells.push(cell);
      existingCellFiles.add(filename);
    } else if (/^[a-f0-9]{64}-reference\.json$/.test(filename)) {
      const ref = referenceSchema.parse(JSON.parse(await readFile(join(options.outputDir, filename), "utf8")) as unknown);
      const repo = validRepositories.get(ref.repository.repository.toLowerCase());
      if (
        !repo ||
        repo.sha !== ref.repository.sha ||
        ref.implementationDigest !== options.implementationDigest ||
        filename !== evalReferenceFileName(ref.repository.repository) ||
        references.has(ref.repository.repository.toLowerCase())
      ) {
        throw new Error("Cannot resume evaluation: reference source identity or digest changed");
      }
      references.set(ref.repository.repository.toLowerCase(), ref);
    }
  }
  aggregateEvaluation(cells);
  return { cells, references, existingCellFiles };
}
