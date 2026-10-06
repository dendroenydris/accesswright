import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LocalNoLlmRuntime,
} from "./core/local-runtime.js";
import {
  runNoLlmRepair,
} from "./core/no-llm.js";
import type {
  NoLlmRepairResult,
  NoLlmRuntime,
} from "./core/no-llm.js";

export interface CliArgs {
  repoPath: string;
  noLlm: boolean;
}

export type NoLlmRuntimeFactory = (repoPath: string) => NoLlmRuntime;

export function parseCliArgs(args: readonly string[]): CliArgs {
  let noLlm = false;
  const positional: string[] = [];

  for (const argument of args) {
    if (argument === "--no-llm") {
      noLlm = true;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }

  if (positional.length !== 1 || positional[0] === undefined) {
    throw new Error(
      "Exactly one repository path is required: accesswright <repo> --no-llm",
    );
  }

  return {
    repoPath: positional[0],
    noLlm,
  };
}

export async function runCli(
  args: readonly string[],
  runtimeFactory: NoLlmRuntimeFactory,
): Promise<NoLlmRepairResult> {
  const parsed = parseCliArgs(args);
  if (!parsed.noLlm) {
    throw new Error(
      "Live LLM mode is not available yet; run this milestone with --no-llm",
    );
  }
  return runNoLlmRepair(runtimeFactory(parsed.repoPath));
}

function environmentPath(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? fallback : value;
}

export function createLocalRuntime(repoPath: string): NoLlmRuntime {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const defaultPackageRoot = resolve(moduleDirectory, "../..");
  const packageRoot = environmentPath(
    "ACCESSWRIGHT_PACKAGE_ROOT",
    defaultPackageRoot,
  );
  const tempRoot = environmentPath(
    "ACCESSWRIGHT_TMP_ROOT",
    join(tmpdir(), "accesswright"),
  );

  return new LocalNoLlmRuntime({
    repoPath: resolve(repoPath),
    tempRoot,
    image:
      process.env.ACCESSWRIGHT_DOCKER_IMAGE ??
      "mcr.microsoft.com/playwright:v1.63.0-noble",
    accesswrightNodeModules: environmentPath(
      "ACCESSWRIGHT_NODE_MODULES",
      join(packageRoot, "node_modules"),
    ),
    accesswrightRuntime: environmentPath(
      "ACCESSWRIGHT_RUNTIME_DIR",
      join(packageRoot, "dist"),
    ),
    npmCache: environmentPath(
      "ACCESSWRIGHT_NPM_CACHE",
      join(tempRoot, "npm-cache"),
    ),
  });
}

async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2), createLocalRuntime);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`accesswright: ${message}\n`);
    process.exitCode = 1;
  });
}
