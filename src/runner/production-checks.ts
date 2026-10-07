import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import type { FinalCheckSnapshot } from "../verifier/final.js";

export const PackageManifestSchema = z.object({
  name: z.string().optional(),
  scripts: z.record(z.string(), z.string()).default({}),
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
  packageManager: z.string().optional(),
}).passthrough();

export type ProductionCheck = "build" | "typecheck" | "lint" | "tests";
export interface ProductionCheckCommand {
  check: ProductionCheck;
  argv: string[];
  available: boolean;
}
export interface ProductionCheckResult extends ProductionCheckCommand {
  status: "passed" | "failed" | "unavailable";
  durationMs: number;
  exitCode: number | null;
  failureIds: string[];
  diagnostic?: string;
}

export function productionCheckPlan(input: unknown, hasTypeScript: boolean): ProductionCheckCommand[] {
  const manifest = PackageManifestSchema.parse(input);
  const scripts = manifest.scripts;
  if (!scripts.build?.trim()) throw new Error("A production build script is required");
  const typeScript = ["typecheck", "type-check", "check:types"].find(name => scripts[name]?.trim());
  const testArgs = /\bvitest\b/.test(scripts.test ?? "") ? ["--", "--run"] : /\bjest\b/.test(scripts.test ?? "") ? ["--", "--runInBand", "--watch=false"] : [];
  return [
    { check: "build", argv: ["npm", "run", "build"], available: true },
    { check: "typecheck", argv: typeScript ? ["npm", "run", typeScript] : hasTypeScript ? ["node_modules/.bin/tsc", "--noEmit"] : [], available: Boolean(typeScript) || hasTypeScript },
    { check: "lint", argv: scripts.lint?.trim() ? ["npm", "run", "lint"] : [], available: Boolean(scripts.lint?.trim()) },
    { check: "tests", argv: scripts.test?.trim() ? ["npm", "test", ...testArgs] : [], available: Boolean(scripts.test?.trim()) },
  ];
}

/** Failure identities retain diagnostic meaning, but never raw repository content. */
export function checkFailureIds(check: ProductionCheck, exitCode: number, output: string): string[] {
  if (exitCode === 0) return [];
  const normalized = stripVTControlCharacters(output)
    .replaceAll("/workspace/", "")
    .replace(/:\d+(?::\d+)?/g, ":<position>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|seconds?|s)\b/g, "<duration>")
    .split("\n").map(line => line.trim()).filter(Boolean);
  const diagnostics = normalized.filter(line => /\b(?:error|failed|failure|FAIL|TS\d+)\b/i.test(line));
  const lines = diagnostics.length > 0 ? diagnostics : normalized.slice(-20);
  if (lines.length === 0) lines.push(`exit-${exitCode}-without-diagnostic`);
  return lines.map(line => `${check}:${createHash("sha256").update(line).digest("hex").slice(0, 20)}`);
}

export function emptyCheckSnapshot(): FinalCheckSnapshot {
  return { build: [], typecheck: [], lint: [], tests: [], violations: [] };
}

export function snapshotFromChecks(checks: readonly ProductionCheckResult[]): FinalCheckSnapshot {
  const snapshot = emptyCheckSnapshot();
  for (const check of checks) snapshot[check.check] = check.failureIds;
  return snapshot;
}
