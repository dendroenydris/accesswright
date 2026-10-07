#!/usr/bin/env node
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseCliArgs } from "./cli-options.js";
import type { CliArgs } from "./cli-options.js";
import { repairRepository } from "./core/repository.js";
import type { RunReport } from "./reporter/report.js";

export { parseCliArgs };
export type { CliArgs };

export type CliCoordinator<T = RunReport> = (options: CliArgs) => Promise<T>;

function environmentPath(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? fallback : value;
}

async function runRepositoryFromCli(options: CliArgs): Promise<RunReport> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const packageRoot = environmentPath(
    "ACCESSWRIGHT_PACKAGE_ROOT",
    resolve(moduleDirectory, "../.."),
  );
  const tempRoot = environmentPath(
    "ACCESSWRIGHT_TMP_ROOT",
    join(tmpdir(), "accesswright"),
  );
  const pricing =
    options.inputUsdPerMillion === undefined ||
    options.outputUsdPerMillion === undefined
      ? undefined
      : {
          inputUsdPerMillion: options.inputUsdPerMillion,
          outputUsdPerMillion: options.outputUsdPerMillion,
        };
  const result = await repairRepository({
    repoPath: resolve(options.repoPath),
    tempRoot,
    runtimeRoot: packageRoot,
    noLlm: options.noLlm,
    dryRun: options.dryRun,
    retainEvidence: options.retainEvidence,
    trustProviderConfig: options.trustProviderConfig,
    maxTasks: options.maxTasks,
    maxCostUsd: options.maxCostUsd,
    ...(options.offline === undefined ? {} : { offline: options.offline }),
    ...(pricing === undefined ? {} : { pricing }),
  });
  return result.report;
}

export function runCli(args: readonly string[]): Promise<RunReport>;
export function runCli<T>(args: readonly string[], coordinator: CliCoordinator<T>): Promise<T>;
export async function runCli<T>(args: readonly string[], coordinator?: CliCoordinator<T>): Promise<RunReport | T> {
  const parsed = parseCliArgs(args);
  return coordinator === undefined ? runRepositoryFromCli(parsed) : coordinator(parsed);
}

export function cliExitCode(report: Pick<RunReport, "status">): number {
  return report.status === "blocked" ? 1 : 0;
}

async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = cliExitCode(result);
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
