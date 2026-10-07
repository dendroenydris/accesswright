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
  expect(action.runs?.using).toBe("composite");
  const uses = action.runs?.steps
    ?.map(step => step.uses)
    .filter((value): value is string => typeof value === "string");
  expect(uses).toContain(
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  );
  expect(uses).toContain(
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  );
});
