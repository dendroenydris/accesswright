import { describe, expect, it } from "vitest";

import { parseCliArgs, runCli } from "../../src/cli.js";

describe("parseCliArgs", () => {
  it("accepts one repository path with --no-llm in either position", () => {
    expect(parseCliArgs(["/tmp/repo", "--no-llm"])).toMatchObject({
      repoPath: "/tmp/repo",
      noLlm: true,
      maxCostUsd: 0,
    });
    expect(parseCliArgs(["--no-llm", "/tmp/repo"])).toMatchObject({
      repoPath: "/tmp/repo",
      noLlm: true,
      maxCostUsd: 0,
    });
  });

  it("rejects an unknown option or missing repository path", () => {
    expect(() => parseCliArgs(["--wat", "/tmp/repo"])).toThrow(/unknown/i);
    expect(() => parseCliArgs(["--no-llm"])).toThrow(/repository/i);
  });
});

describe("runCli", () => {
  it("passes parsed arguments to the selected coordinator", async () => {
    const seen: unknown[] = [];
    const result = await runCli(["/tmp/repo", "--no-llm"], parsed => {
      seen.push(parsed);
      return Promise.resolve({ fixed: 0 });
    });
    expect(seen).toEqual([expect.objectContaining({ repoPath: "/tmp/repo", noLlm: true })]);
    expect(result).toEqual({ fixed: 0 });
  });
});
