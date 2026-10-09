#!/usr/bin/env node
import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { RunReportSchema } from "./report.js";
import { renderGermanEvidenceReport } from "./evidence-report-de.js";

export interface GermanEvidenceCliArgs {
  report: string;
  commits: string;
  out: string;
}

export function parseGermanEvidenceArgs(args: readonly string[]): GermanEvidenceCliArgs {
  const seen = new Map<string, string>();
  const allowed = new Set(["--report", "--commits", "--out"]);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!name || !allowed.has(name)) throw new Error("Unknown German evidence report option");
    if (seen.has(name)) throw new Error("Duplicate German evidence report option");
    if (!value || value.startsWith("--")) throw new Error("Missing German evidence report option value");
    if (!isAbsolute(value)) throw new Error("German evidence report paths must be absolute");
    seen.set(name, value);
  }
  const report = seen.get("--report"), commits = seen.get("--commits"), out = seen.get("--out");
  if (!report || !commits || !out) throw new Error("German evidence report needs --report, --commits and --out");
  return { report, commits, out };
}

async function readBoundedJson(path: string, maxBytes: number): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error("German evidence report input is not a bounded regular file");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

/** No network, no secrets or source, no overwriting a previous evidence report. */
export async function runGermanEvidenceCli(args: readonly string[]): Promise<string> {
  const paths = parseGermanEvidenceArgs(args);
  const report = RunReportSchema.parse(await readBoundedJson(paths.report, 2 * 1024 * 1024));
  const commitList = z.array(z.object({
    id: z.string().min(1),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
  }).strict()).max(200).parse(await readBoundedJson(paths.commits, 128 * 1024));
  const text = renderGermanEvidenceReport(report, { commits: commitList });
  await writeFile(paths.out, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return paths.out;
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  runGermanEvidenceCli(process.argv.slice(2)).then(path => {
    process.stdout.write("German evidence report created: " + path + "\n");
  }).catch(() => {
    process.stderr.write("German evidence report failed; check the report inputs and destination\n");
    process.exitCode = 1;
  });
}
