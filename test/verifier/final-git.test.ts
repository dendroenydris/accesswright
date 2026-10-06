import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { expect, it } from "vitest";

import { verifyFinal } from "../../src/verifier/final.js";
import type { FinalCheckSnapshot } from "../../src/verifier/final.js";

const clean: FinalCheckSnapshot = {
  build: [],
  typecheck: [],
  lint: [],
  tests: [],
  violations: [],
};

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execa("git", [...args], { cwd });
  return result.stdout.trim();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

it("bisects real local Git commits and drops the breaking commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "accesswright-final-git-"));
  const source = join(root, "source");
  let candidateIndex = 0;

  try {
    await git(root, ["init", "-q", source]);
    await git(source, ["config", "user.name", "Accesswright Test"]);
    await git(source, ["config", "user.email", "test@accesswright.invalid"]);

    await writeFile(join(source, "README.md"), "base\n", "utf8");
    await git(source, ["add", "README.md"]);
    await git(source, ["commit", "-q", "-m", "base"]);
    const base = await git(source, ["rev-parse", "HEAD"]);

    await writeFile(join(source, "good-a.txt"), "good-a\n", "utf8");
    await git(source, ["add", "good-a.txt"]);
    await git(source, ["commit", "-q", "-m", "good a"]);
    const goodA = await git(source, ["rev-parse", "HEAD"]);

    await writeFile(join(source, "bad.txt"), "BREAK\n", "utf8");
    await git(source, ["add", "bad.txt"]);
    await git(source, ["commit", "-q", "-m", "bad"]);
    const bad = await git(source, ["rev-parse", "HEAD"]);

    await writeFile(join(source, "good-c.txt"), "good-c\n", "utf8");
    await git(source, ["add", "good-c.txt"]);
    await git(source, ["commit", "-q", "-m", "good c"]);
    const goodC = await git(source, ["rev-parse", "HEAD"]);

    const runChecks = async (
      fixIds: readonly string[],
    ): Promise<FinalCheckSnapshot> => {
      candidateIndex += 1;
      const candidate = join(root, `candidate-${candidateIndex}`);
      await git(root, ["clone", "-q", source, candidate]);
      await git(candidate, ["switch", "-q", "--detach", base]);
      await git(candidate, ["config", "user.name", "Accesswright Test"]);
      await git(candidate, ["config", "user.email", "test@accesswright.invalid"]);

      for (const fixId of fixIds) {
        await git(candidate, ["cherry-pick", fixId]);
      }

      return (await fileExists(join(candidate, "bad.txt")))
        ? { ...clean, build: ["breaking-fixture"] }
        : clean;
    };

    const result = await verifyFinal({
      baseline: clean,
      fixIds: [goodA, bad, goodC],
      runChecks,
      rerunTests: () => Promise.resolve([]),
    });

    expect(result.acceptedFixIds).toEqual([goodA, goodC]);
    expect(result.droppedFixIds).toEqual([bad]);
    expect(result.failures).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
