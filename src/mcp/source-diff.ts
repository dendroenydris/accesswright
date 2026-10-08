import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { listSnapshotFiles } from "../runner/patch-journal.js";
import { isSourcePath } from "../types/schemas.js";
import type { Patch } from "../types/schemas.js";

const LimitSchema = z.object({
  maxChanges: z.number().int().positive().max(20).default(8),
  maxBytesPerFile: z.number().int().positive().max(1_048_576).default(262_144),
}).strict();
export type SourceDiffLimits = z.input<typeof LimitSchema>;

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Compare two already-sanitized regular-file source snapshots without
 * reading unchanged binary assets into memory. Never adds or removes files:
 * the user can still review such changes, but the verifier cannot approve them.
 */
export async function compareSourceSnapshots(
  beforeRoot: string,
  afterRoot: string,
  limits: SourceDiffLimits = {},
): Promise<Patch["changes"]> {
  const policy = LimitSchema.parse(limits);
  const beforeFiles = await listSnapshotFiles(beforeRoot);
  const afterFiles = await listSnapshotFiles(afterRoot);
  if (
    beforeFiles.length !== afterFiles.length ||
    beforeFiles.some((path, index) => path !== afterFiles[index])
  ) {
    throw new Error("Source file set changed (added or deleted files); cannot verify partial patch");
  }
  const changes: Patch["changes"] = [];
  for (const path of beforeFiles) {
    const oldPath = join(beforeRoot, path);
    const newPath = join(afterRoot, path);
    const oldStat = await stat(oldPath), newStat = await stat(newPath);
    if (oldStat.size === newStat.size && await digest(oldPath) === await digest(newPath)) continue;
    if (!isSourcePath(path)) throw new Error("Non-source file modified after MCP scan");
    if (oldStat.size > policy.maxBytesPerFile || newStat.size > policy.maxBytesPerFile) {
      throw new Error("Changed source file exceeds MCP size limit");
    }
    if (await digest(oldPath) === await digest(newPath)) continue;
    changes.push({
      path,
      before: await readFile(oldPath, "utf8"),
      after: await readFile(newPath, "utf8"),
    });
    if (changes.length > policy.maxChanges) throw new Error("Changed source file count exceeds MCP limit");
  }
  return changes;
}
