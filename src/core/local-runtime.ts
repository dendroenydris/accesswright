import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { applySourcePatch, copyTargetSnapshot, resolveSafeSource } from "../sandbox/source-boundary.js";

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

async function copyCandidateRepository(
  repoPath: string,
  tempRoot: string,
): Promise<string> {
  await mkdir(tempRoot, { recursive: true });
  const destination = await mkdtemp(join(tempRoot, "candidate-"));
  await copyTargetSnapshot(repoPath, destination);
  return destination;
}

async function applyPatchToRoot(root: string, patch: Patch): Promise<void> {
  await applySourcePatch(root, patch);
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

  async readSource(path: string): Promise<string> {
    return readFile(await resolveSafeSource(this.options.repoPath, path), "utf8");
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
