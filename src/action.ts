import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as core from "@actions/core";
import { z } from "zod";
import { defaults } from "./config.js";
import { runBacklogAction } from "./action/backlog.js";
import type { BacklogActionOptions } from "./action/backlog.js";
import { runPullRequestAction } from "./action/pull-request.js";
import type { PullRequestActionOptions } from "./action/pull-request.js";
import { renderPullRequestReport } from "./reporter/report.js";
import { verifyCheckoutProvenance } from "./runner/checkout-provenance.js";

export type ActionOptions =
  | (BacklogActionOptions & { mode: "backlog" })
  | (PullRequestActionOptions & { mode: "pr" });

/** Values are provided by the calling workflow, never loaded from target code. */
export function parseActionEnvironment(env: Readonly<Record<string, string | undefined>>): ActionOptions {
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
  const mode = z.enum(["backlog", "pr"]).parse(env.ACCESSWRIGHT_ACTION_MODE || "backlog");
  if (env.GITHUB_REF_TYPE !== "branch") throw new Error("Action requires a branch context");
  const allowedEvents = mode === "backlog" ? ["workflow_dispatch", "schedule"] : ["workflow_dispatch", "pull_request"];
  if (env.GITHUB_EVENT_NAME && !allowedEvents.includes(env.GITHUB_EVENT_NAME)) {
    throw new Error("Action trigger is not authorized for selected mode; use the reviewed workflow_dispatch or permitted event");
  }
  const workspace = required("GITHUB_WORKSPACE");
  const runtimeRoot = required("GITHUB_ACTION_PATH");
  const runnerTemp = required("RUNNER_TEMP");
  const repoPath = env.ACCESSWRIGHT_ACTION_REPO_PATH || workspace;
  if (![workspace, runtimeRoot, runnerTemp, repoPath].every(isAbsolute)) throw new Error("Action paths must be absolute");
  const fork = mode === "pr" && boolean("ACCESSWRIGHT_ACTION_IS_FORK", false);
  const noLlm = fork || boolean("ACCESSWRIGHT_ACTION_NO_LLM", true);
  const maxCostUsd = fork ? 0 : number("ACCESSWRIGHT_ACTION_MAX_COST_USD", defaults.maxRunCostUsd);
  const maxTasks = number("ACCESSWRIGHT_ACTION_MAX_TASKS", defaults.maxTasks);
  if (!Number.isSafeInteger(maxTasks) || maxTasks < 1) throw new Error("maxTasks must be a positive integer");
  const pricesProvided = !fork && Boolean(env.ACCESSWRIGHT_ACTION_INPUT_USD_PER_MILLION || env.ACCESSWRIGHT_ACTION_OUTPUT_USD_PER_MILLION);
  const pricing = (!noLlm && maxCostUsd > 0) || pricesProvided ? {
    inputUsdPerMillion: number("ACCESSWRIGHT_ACTION_INPUT_USD_PER_MILLION"),
    outputUsdPerMillion: number("ACCESSWRIGHT_ACTION_OUTPUT_USD_PER_MILLION"),
  } : undefined;
  const repository = z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/).parse(required("GITHUB_REPOSITORY"));
  const sha = z.string().regex(/^[a-f0-9]{40}$/);
  const shared = {
    repoPath, tempRoot: join(runnerTemp, "accesswright"), runtimeRoot, repository,
    githubToken: required("ACCESSWRIGHT_ACTION_GITHUB_TOKEN"),
    noLlm, offline: boolean("ACCESSWRIGHT_ACTION_OFFLINE", false),
    retainEvidence: boolean("ACCESSWRIGHT_ACTION_RETAIN_EVIDENCE", false),
    maxTasks, maxCostUsd, ...(pricing === undefined ? {} : { pricing }),
  };
  if (mode === "pr") {
    return {
      ...shared, mode,
      pullNumber: z.coerce.number().int().positive().parse(required("ACCESSWRIGHT_ACTION_PULL_NUMBER")),
      verifiedHeadSha: sha.parse(required("ACCESSWRIGHT_ACTION_HEAD_SHA")),
      isFork: fork,
    };
  }
  return {
    ...shared, mode,
    baseBranch: env.ACCESSWRIGHT_ACTION_BASE_BRANCH || required("GITHUB_REF_NAME"),
    verifiedBaseSha: sha.parse(env.ACCESSWRIGHT_ACTION_BASE_SHA || required("GITHUB_SHA")),
    publisherLogin: "github-actions[bot]",
  };
}

/** Only fixed-shape transport metadata may leave the private error boundary. */
export function actionFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown";
  const diagnostic = createHash("sha256").update(message).digest("hex").slice(0, 16);
  const known = /^GitHub (GET|POST|PATCH) failed with HTTP [1-5][0-9]{2}$/.test(message) ? ` ${message}.` : "";
  return `Accesswright Action failed; diagnostic ${diagnostic}.${known} No unverified repair is authorized for publication.`;
}

async function main(): Promise<void> {
  const options = parseActionEnvironment(process.env);
  core.setSecret(options.githubToken);
  await verifyCheckoutProvenance(
    options.repoPath,
    options.mode === "pr" ? options.verifiedHeadSha : options.verifiedBaseSha,
  );
  const result = options.mode === "pr"
    ? await runPullRequestAction(options)
    : await runBacklogAction(options);
  core.setOutput("status", result.status);
  core.setOutput("pull-request-url", options.mode === "backlog" ? ("prUrl" in result ? result.prUrl ?? "" : "") : "");
  core.setOutput("fixed", result.report.fixed);
  core.setOutput("evidence-directory", result.evidenceDir);
  core.setOutput("suggestions", "suggestions" in result ? result.suggestions : 0);
  core.setOutput("handoffs", "handoffs" in result ? result.handoffs : 0);
  await core.summary.addRaw(renderPullRequestReport(result.report)).write();
  if (result.status === "blocked") core.setFailed(result.reason ?? "Final verification blocked publication");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    core.setFailed(actionFailureMessage(error));
  });
}
