import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";
import YAML from "yaml";

import { parseActionEnvironment } from "../../src/action.js";

const baseEnvironment = {
  GITHUB_WORKSPACE: "/workspace",
  RUNNER_TEMP: "/runner-temp",
  GITHUB_ACTION_PATH: "/actions/accesswright",
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_REF_NAME: "main",
  GITHUB_REF_TYPE: "branch",
  GITHUB_SHA: "a".repeat(40),
  ACCESSWRIGHT_ACTION_GITHUB_TOKEN: "fixture-token",
};

it("parses safe backlog defaults with no paid authorization", () => {
  expect(parseActionEnvironment(baseEnvironment)).toMatchObject({
    repoPath: "/workspace",
    tempRoot: "/runner-temp/accesswright",
    runtimeRoot: "/actions/accesswright",
    repository: "owner/repo",
    baseBranch: "main",
    verifiedBaseSha: "a".repeat(40),
    githubToken: "fixture-token",
    publisherLogin: "github-actions[bot]",
    noLlm: true,
    offline: false,
    retainEvidence: false,
    maxTasks: 20,
    maxCostUsd: 0,
  });
});

it("parses pull-request mode and forces fork contexts to no-LLM", () => {
  expect(parseActionEnvironment({
    ...baseEnvironment,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REF_TYPE: "branch",
    ACCESSWRIGHT_ACTION_MODE: "pr",
    ACCESSWRIGHT_ACTION_PULL_NUMBER: "7",
    ACCESSWRIGHT_ACTION_HEAD_SHA: "b".repeat(40),
    ACCESSWRIGHT_ACTION_IS_FORK: "true",
    ACCESSWRIGHT_ACTION_NO_LLM: "false",
    ACCESSWRIGHT_ACTION_MAX_COST_USD: "1",
  })).toMatchObject({
    mode: "pr",
    pullNumber: 7,
    verifiedHeadSha: "b".repeat(40),
    isFork: true,
    noLlm: true,
    maxCostUsd: 0,
  });
});

it("requires explicit prices before an Action run can authorize LLM spend", () => {
  expect(() =>
    parseActionEnvironment({
      ...baseEnvironment,
      ACCESSWRIGHT_ACTION_NO_LLM: "false",
      ACCESSWRIGHT_ACTION_MAX_COST_USD: "0.1",
    }),
  ).toThrow(/price/i);

  expect(
    parseActionEnvironment({
      ...baseEnvironment,
      ACCESSWRIGHT_ACTION_NO_LLM: "false",
      ACCESSWRIGHT_ACTION_MAX_COST_USD: "0.1",
      ACCESSWRIGHT_ACTION_INPUT_USD_PER_MILLION: "0.2",
      ACCESSWRIGHT_ACTION_OUTPUT_USD_PER_MILLION: "1.2",
    }).pricing,
  ).toEqual({ inputUsdPerMillion: 0.2, outputUsdPerMillion: 1.2 });
});

it("rejects tag or malformed Action contexts before repair", () => {
  expect(() =>
    parseActionEnvironment({ ...baseEnvironment, GITHUB_REF_TYPE: "tag" }),
  ).toThrow(/branch/i);
  expect(() =>
    parseActionEnvironment({
      ...baseEnvironment,
      ACCESSWRIGHT_ACTION_NO_LLM: "maybe",
    }),
  ).toThrow(/boolean/i);
});

it("declares a pinned composite Action with safe default inputs", async () => {
  const action = YAML.parse(await readFile("action.yml", "utf8")) as {
    inputs?: Record<string, { default?: string }>;
    runs?: { using?: string; steps?: Array<Record<string, unknown>> };
  };
  expect(action.inputs?.["no-llm"]?.default).toBe("true");
  expect(action.inputs?.["max-cost-usd"]?.default).toBe("0");
  expect(action.inputs?.mode?.default).toBe("backlog");
  expect(action.inputs?.["pull-number"]?.default).toBe("");
  expect(action.inputs?.["head-sha"]?.default).toBe("");
  expect(action.runs?.using).toBe("composite");
  const uses = action.runs?.steps
    ?.map(step => step.uses)
    .filter((value): value is string => typeof value === "string");
  expect(uses).toContain(
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  );
  expect(uses).toContain(
    "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
  );
  expect(action.runs?.steps?.find(step => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@"))?.with).toMatchObject({
    "package-manager-cache": false,
  });
});
