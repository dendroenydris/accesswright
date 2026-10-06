import { describe, expect, it } from "vitest";

import { parseCliArgs, runCli } from "../../src/cli.js";
import type { NoLlmRuntime } from "../../src/core/no-llm.js";
import type { PageVerificationState } from "../../src/verifier/per-patch.js";

class CleanRuntime implements NoLlmRuntime {
  scan(): Promise<PageVerificationState> {
    return Promise.resolve({ violations: [], aria: [], probeFailures: [] });
  }

  readSource(): Promise<string> {
    throw new Error("readSource should not be called for a clean scan");
  }

  scanCandidate(): Promise<PageVerificationState> {
    throw new Error("scanCandidate should not be called for a clean scan");
  }

  applyVerifiedPatch(): Promise<void> {
    throw new Error("applyVerifiedPatch should not be called for a clean scan");
  }
}

describe("parseCliArgs", () => {
  it("accepts one repository path with --no-llm in either position", () => {
    expect(parseCliArgs(["/tmp/repo", "--no-llm"])).toEqual({
      repoPath: "/tmp/repo",
      noLlm: true,
    });
    expect(parseCliArgs(["--no-llm", "/tmp/repo"])).toEqual({
      repoPath: "/tmp/repo",
      noLlm: true,
    });
  });

  it("rejects an unknown option or missing repository path", () => {
    expect(() => parseCliArgs(["--wat", "/tmp/repo"])).toThrow(/unknown/i);
    expect(() => parseCliArgs(["--no-llm"])).toThrow(/repository/i);
  });
});

describe("runCli", () => {
  it("runs the no-LLM coordinator with the selected repository", async () => {
    const seen: string[] = [];
    const result = await runCli(
      ["/tmp/repo", "--no-llm"],
      (repoPath) => {
        seen.push(repoPath);
        return new CleanRuntime();
      },
    );

    expect(seen).toEqual(["/tmp/repo"]);
    expect(result).toEqual({
      fixed: 0,
      rejected: 0,
      needsHuman: 0,
      attempts: 0,
    });
  });

  it("refuses live-LLM mode until the LLM milestone exists", async () => {
    await expect(
      runCli(["/tmp/repo"], () => new CleanRuntime()),
    ).rejects.toThrow(/--no-llm/i);
  });
});
