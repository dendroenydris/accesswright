import { describe, expect, it } from "vitest";
import { parseCliArgs, runCli } from "../../src/cli.js";

describe("verified CLI entrypoint", () => {
  it("defaults to zero paid authorization, not a repository-controlled spending allowance", () => {
    expect(parseCliArgs(["fix", "/tmp/repo"])).toMatchObject({ repoPath: "/tmp/repo", maxCostUsd: 0, dryRun: false, retainEvidence: false });
  });
  it("passes explicit verifier, privacy and spending options to the real coordinator", async () => {
    const options = ["fix", "/tmp/repo", "--no-llm", "--offline", "--dry-run", "--retain-evidence", "--max-tasks", "3", "--max-cost-usd", "0.2"];
    const seen: unknown[] = [];
    const result = await runCli(options, parsed => { seen.push(parsed); return Promise.resolve({ status: "verified" }); });
    expect(result).toEqual({ status: "verified" });
    expect(seen).toEqual([expect.objectContaining({ repoPath: "/tmp/repo", noLlm: true, offline: true, dryRun: true, retainEvidence: true, maxTasks: 3, maxCostUsd: 0.2 })]);
  });
  it("rejects invalid operator options", () => {
    const invalid = [["--max-cost-usd", "NaN"], ["--max-cost-usd", "-1"], ["--max-tasks", "0"], ["--max-tasks", "1.5"], ["--input-usd-per-million", "Infinity"], ["--max-tasks"]];
    for (const flags of invalid) expect(() => parseCliArgs(["/tmp/repo", ...flags])).toThrow();
  });
  it("does not revive the old milestone-only refusal for model mode", async () => {
    expect(await runCli(["/tmp/repo"], parsed => Promise.resolve(parsed.noLlm))).toBe(false);
  });
});
