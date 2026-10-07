import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const retainedMetadata = new Set(["report.json", "run.jsonl", "baseline-checks.json", "final-verification.json"]);

/** Only coordinator-written metadata is retained unless the operator explicitly opts in to private evidence. */
export async function clearPrivateEvidence(directory: string, retain: boolean): Promise<void> {
  if (retain) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !retainedMetadata.has(entry.name)) await rm(join(directory, entry.name), { recursive: true, force: true });
  }
}
