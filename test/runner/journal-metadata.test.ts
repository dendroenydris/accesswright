import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PatchJournal } from "../../src/runner/patch-journal.js";

it("cleans only transferred platform metadata before removing an owned temporary worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-journal-metadata-"));
  try {
    await writeFile(join(root, "index.ts"), "export const value = 1;\n");
    const journal = await PatchJournal.create(root);
    const selected = await journal.materialize([]);
    await writeFile(join(selected.path, "._index.ts"), "AppleDouble transport metadata");
    await expect(selected.close()).resolves.toBeUndefined();
    const protectedSelection = await journal.materialize([]);
    await writeFile(join(protectedSelection.path, "human.ts"), "export const human = true;\n");
    await expect(protectedSelection.close()).rejects.toThrow(/modified|untracked/);
    expect(await readFile(join(protectedSelection.path, "human.ts"), "utf8")).toContain("human = true");
    await rm(join(protectedSelection.path, "human.ts"));
    await protectedSelection.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
