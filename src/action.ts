import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import * as core from "@actions/core";
import { z } from "zod";
import { defaults } from "./config.js";
import { runBacklogAction } from "./action/backlog.js";
import type { BacklogActionOptions } from "./action/backlog.js";
import { renderPullRequestReport } from "./reporter/report.js";

/** Values are provided by the calling workflow, never loaded from target code. */
export function parseActionEnvironment(env: Readonly<Record<string, string | undefined>>): BacklogActionOptions {
  const required = (name: string): string => {
    const value = env[name];
    if (!value?.trim()) throw new Error(`Missing Action environment variable: ${name}`);
    return value;
  };
  const boolean = (name: string, fallback: boolean): boolean => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    if (value !== "true" && value !== "false") throw new Error(`Invalid boolean: ${name}`);
    return value === "true";
  };
  const number = (name: string, fallback?: number): number => {
    const text = env[name];
    if (text === undefined || text.trim() === "") {
      if (fallback === undefined) throw new Error(`Model price is required: ${name}`);
      return fallback;
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid numeric Action option: ${name}`);
    return value;
  };
  if (env.GITHUB_REF_TYPE !== "branch") throw new Error("Backlog mode requires a branch context");
  if (env.GITHUB_EVENT_NAME && !["workflow_dispatch", "schedule"].includes(env.GITHUB_EVENT_NAME)) {
    throw new Error("Backlog Action accepts only workflow_dispatch or schedule; PR triggers are not authorized");
  }
  const workspace = required("GITHUB_WORKSPACE");
  const runtimeRoot = required("GITHUB_ACTION_PATH");
  const runnerTemp = required("RUNNER_TEMP");
  const repoPath = env.ACCESSWRIGHT_ACTION_REPO_PATH || workspace;
  if (![workspace, runtimeRoot, runnerTemp, repoPath].every(isAbsolute)) throw new Error("Action paths must be absolute");
  const noLlm = boolean("ACCESSWRIGHT_ACTION_NO_LLM", true);
  const maxCostUsd = number("ACCESSWRIGHT_ACTION_MAX_COST_USD", defaults.maxRunCostUsd);
  const maxTasks = number("ACCESSWRIGHT_ACTION_MAX_TASKS", defaults.maxTasks);
  if (!Number.isSafeInteger(maxTasks) || maxTasks < 1) throw new Error("maxTasks must be a positive integer");
  const pricesProvided = Boolean(env.ACCESSWRIGHT_ACTION_INPUT_USD_PER_MILLION || env.ACCESSWRIGHT_ACTION_OUTPUT_USD_PER_MILLION);
  const pricing = (!noLlm && maxCostUsd > 0) || pricesProvided ? {
    inputUsdPerMillion: number("ACCESSWRIGHT_ACTION_INPUT_USD_PER_MILLION"),
    outputUsdPerMillion: number("ACCESSWRIGHT_ACTION_OUTPUT_USD_PER_MILLION"),
  } : undefined;
  const repository = z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/).parse(required("GITHUB_REPOSITORY"));
  const verifiedBaseSha = z.string().regex(/^[a-f0-9]{40}$/).parse(env.ACCESSWRIGHT_ACTION_BASE_SHA || required("GITHUB_SHA"));
  return { repoPath, tempRoot: join(runnerTemp, "accesswright"), runtimeRoot, repository,
    baseBranch: env.ACCESSWRIGHT_ACTION_BASE_BRANCH || required("GITHUB_REF_NAME"), verifiedBaseSha,
    githubToken: required("ACCESSWRIGHT_ACTION_GITHUB_TOKEN"), publisherLogin: "github-actions[bot]",
    noLlm, offline: boolean("ACCESSWRIGHT_ACTION_OFFLINE", false), retainEvidence: boolean("ACCESSWRIGHT_ACTION_RETAIN_EVIDENCE", false),
    maxTasks, maxCostUsd, ...(pricing === undefined ? {} : { pricing }) };
}

/** Read-only Git commands with hooks/config helpers disabled. No target code is executed. */
export async function verifyActionCheckout(repoPath: string, expectedSha: string): Promise<void> {
  const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  const git = async (args: string[]) => (await execa("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repoPath, env: environment, extendEnv: false })).stdout.trim();
  if (await git(["rev-parse", "HEAD"]) !== expectedSha) throw new Error("Action checkout does not match its verified base SHA");
  if (await git(["status", "--porcelain", "--untracked-files=all"])) throw new Error("Action target checkout is not clean; unverified inputs were preserved");
}

async function main(): Promise<void> {
  const options = parseActionEnvironment(process.env);
  core.setSecret(options.githubToken);
  await verifyActionCheckout(options.repoPath, options.verifiedBaseSha);
  const result = await runBacklogAction(options);
  core.setOutput("status", result.status);
  core.setOutput("pull-request-url", result.prUrl ?? "");
  core.setOutput("fixed", result.report.fixed);
  core.setOutput("evidence-directory", result.evidenceDir);
  await core.summary.addRaw(renderPullRequestReport(result.report)).write();
  if (result.status === "blocked") core.setFailed(result.reason ?? "Final verification blocked publication");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    // SDK exceptions can contain request bodies. Logs expose a correlation digest, not that body.
    const diagnostic = createHash("sha256").update(error instanceof Error ? error.message : "unknown").digest("hex").slice(0, 16);
    core.setFailed(`Accesswright Action failed; diagnostic ${diagnostic}. No unverified repair is authorized for publication.`);
  });
}
