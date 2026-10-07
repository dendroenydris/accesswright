import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BrowserObservationSchema } from "../scanner/observations.js";
import type { BrowserObservation } from "../scanner/observations.js";

const retainedMetadata = new Set(["report.json", "run.jsonl", "baseline-checks.json", "final-verification.json"]);

/** Raw page facts can contain private content, so saving them requires explicit opt-in. */
export async function recordPrivateScan(directory: string, generation: string, observations: readonly BrowserObservation[], retain: boolean): Promise<void> {
  if (!retain) return;
  const name = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100).parse(generation);
  const pages = z.array(BrowserObservationSchema).parse(observations);
  await writeFile(join(directory, `${name}-observations.json`), `${JSON.stringify(pages, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

/** Only coordinator-written metadata is retained unless the operator explicitly opts in to private evidence. */
export async function clearPrivateEvidence(directory: string, retain: boolean): Promise<void> {
  if (retain) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !retainedMetadata.has(entry.name)) await rm(join(directory, entry.name), { recursive: true, force: true });
  }
}
