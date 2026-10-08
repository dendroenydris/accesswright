import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { compareSourceSnapshots } from "../../src/mcp/source-diff.js";

const roots: string[] = [];
async function pair(): Promise<{ before: string; after: string }> {
  const root = await mkdtemp(join(tmpdir(), "aw-mcp-diff-"));
  roots.push(root);
  const before = join(root, "before"), after = join(root, "after");
  await mkdir(join(before, "app"), { recursive: true });
  await mkdir(join(after, "app"), { recursive: true });
  await writeFile(join(before, "package.json"), '{"name":"fixture"}\n');
  await writeFile(join(after, "package.json"), '{"name":"fixture"}\n');
  return { before, after };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("collects only exact changed source bytes, never silently modifies the repository", async () => {
  const { before, after } = await pair();
  await writeFile(join(before, "app/page.tsx"), "export const name = 'before';\n");
  await writeFile(join(after, "app/page.tsx"), "export const name = 'after';\n");
  expect(await compareSourceSnapshots(before, after)).toEqual([{
    path: "app/page.tsx",
    before: "export const name = 'before';\n",
    after: "export const name = 'after';\n",
  }]);
});

it("rejects manifest changes, file additions/deletions, or unsupported binary changes", async () => {
  const { before, after } = await pair();
  await writeFile(join(before, "app/page.tsx"), "const same = true;\n");
  await writeFile(join(after, "app/page.tsx"), "const same = true;\n");
  await writeFile(join(after, "package.json"), '{"name":"mutated"}\n');
  await expect(compareSourceSnapshots(before, after)).rejects.toThrow(/non-source/i);
  await writeFile(join(after, "package.json"), '{"name":"fixture"}\n');
  await writeFile(join(after, "app/new.tsx"), "const surprise = true;\n");
  await expect(compareSourceSnapshots(before, after)).rejects.toThrow(/added|deleted|file set/i);
});

it("fails closed on oversized or multiple unrelated source edits", async () => {
  const { before, after } = await pair();
  for (const name of ["a.tsx", "b.tsx"]) {
    await writeFile(join(before, "app", name), "const value = 1;\n");
    await writeFile(join(after, "app", name), "const value = 2;\n");
  }
  await expect(compareSourceSnapshots(before, after, { maxChanges: 1 })).rejects.toThrow(/limit/i);
  await writeFile(join(after, "app/a.tsx"), "x".repeat(1024));
  await expect(compareSourceSnapshots(before, after, { maxBytesPerFile: 100 })).rejects.toThrow(/size|large/i);
});
