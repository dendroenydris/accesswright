import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { NoLlmRuntime } from "./no-llm.js";
import {
  scanRepository,
} from "../runner/repository-scan.js";
import type {
  RepositoryScanOptions,
  RepositoryScanResult,
} from "../runner/repository-scan.js";
import type { Patch } from "../types/schemas.js";
import type { PageVerificationState } from "../verifier/per-patch.js";

export interface LocalNoLlmRuntimeOptions extends RepositoryScanOptions {
  repoPath: string;
}

export function resolveSourcePath(
  repoPath: string,
  sourcePath: string,
): string {
  if (isAbsolute(sourcePath)) {
    throw new Error("Source path must stay inside the repository");
  }

  const root = resolve(repoPath);
  const candidate = resolve(root, sourcePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("Source path must stay inside the repository");
  }
  return candidate;
}

export function ariaSnapshotFailures(
  baseline: ReadonlyMap<string, string>,
  candidate: ReadonlyMap<string, string>,
): string[] {
  const routes = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
  return routes.flatMap((route) =>
    baseline.get(route) === candidate.get(route) ? [] : [`aria-tree:${route}`],
  );
}

function toVerificationState(
  scan: RepositoryScanResult,
  probeFailures: string[] = [],
): PageVerificationState {
  return {
    violations: scan.violations,
    aria: [],
    probeFailures,
  };
}

function excludedCopyPath(root: string, source: string): boolean {
  const path = relative(root, source);
  if (path.length === 0) return false;
  const segments = path.split(sep);
  const first = segments[0];
  return (
    first === ".git" ||
    first === ".next" ||
    first === "node_modules" ||
    first === ".accesswright" ||
    segments.some(
      (segment) => segment.startsWith("._") || segment === ".DS_Store",
    )
  );
}

async function copyCandidateRepository(
  repoPath: string,
  tempRoot: string,
): Promise<string> {
  await mkdir(tempRoot, { recursive: true });
  const destination = await mkdtemp(join(tempRoot, "candidate-"));
  await cp(repoPath, destination, {
    recursive: true,
    filter: (source) => !excludedCopyPath(repoPath, source),
  });
  return destination;
}

async function applyPatchToRoot(root: string, patch: Patch): Promise<void> {
  const prepared: Array<{
    path: string;
    before: string;
    after: string;
  }> = [];

  for (const change of patch.changes) {
    const path = resolveSourcePath(root, change.path);
    const current = await readFile(path, "utf8");
    if (current !== change.before) {
      throw new Error(`Source changed before patch application: ${change.path}`);
    }
    prepared.push({ path, before: current, after: change.after });
  }

  const written: typeof prepared = [];
  try {
    for (const change of prepared) {
      await writeFile(change.path, change.after, "utf8");
      written.push(change);
    }
  } catch (error) {
    for (const change of written.reverse()) {
      await writeFile(change.path, change.before, "utf8").catch(() => undefined);
    }
    throw error;
  }
}

export class LocalNoLlmRuntime implements NoLlmRuntime {
  private readonly options: LocalNoLlmRuntimeOptions;
  private baseline: RepositoryScanResult | null = null;

  constructor(options: LocalNoLlmRuntimeOptions) {
    this.options = options;
  }

  async scan(): Promise<PageVerificationState> {
    const scan = await scanRepository(this.options.repoPath, this.options);
    this.baseline = scan;
    return toVerificationState(scan);
  }

  readSource(path: string): Promise<string> {
    return readFile(resolveSourcePath(this.options.repoPath, path), "utf8");
  }

  async scanCandidate(patch: Patch): Promise<PageVerificationState> {
    if (this.baseline === null) {
      throw new Error("A baseline scan is required before candidate verification");
    }

    const candidateRoot = await copyCandidateRepository(
      this.options.repoPath,
      join(this.options.tempRoot, "candidates"),
    );
    try {
      await applyPatchToRoot(candidateRoot, patch);
      const candidate = await scanRepository(candidateRoot, this.options);
      return toVerificationState(
        candidate,
        ariaSnapshotFailures(this.baseline.ariaTrees, candidate.ariaTrees),
      );
    } finally {
      await rm(candidateRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  applyVerifiedPatch(patch: Patch): Promise<void> {
    return applyPatchToRoot(this.options.repoPath, patch);
  }
}
