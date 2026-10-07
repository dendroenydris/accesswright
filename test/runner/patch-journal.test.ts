import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PatchJournal } from "../../src/runner/patch-journal.js";
import { applySourcePatch } from "../../src/sandbox/source-boundary.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it("replays separately verified commits without reverting unrelated fixes in the same file", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-journal-")); roots.push(root);
  const source = 'export const first = "before";\n\n\n\nexport const second = "before";\n';
  await writeFile(join(root, "index.ts"), source);
  const journal = await PatchJournal.create(root);
  const first = await applySourcePatch(root, { taskId: "first", changes: [{ path: "index.ts", before: 'first = "before"', after: 'first = "after"' }] });
  const a = await journal.record(first, { accepted: true, check: "ok", reason: null });
  const second = await applySourcePatch(root, { taskId: "second", changes: [{ path: "index.ts", before: 'second = "before"', after: 'second = "after"' }] });
  const b = await journal.record(second, { accepted: true, check: "ok", reason: null });
  expect(a.commit).toMatch(/^[a-f0-9]{40}$/); expect(b.commit).not.toBe(a.commit);
  const selected = await journal.materialize(["second"]);
  try {
    expect(selected.replayFailures).toEqual([]);
    expect(await readFile(join(selected.path, "index.ts"), "utf8")).toBe(source.replace('second = "before"', 'second = "after"'));
    expect(await readFile(join(root, "index.ts"), "utf8")).toContain('first = "after"');
  } finally { await selected.close(); }
}, 15000);

it("refuses a rejected patch, unknown fix IDs, and an existing Git workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-journal-")); roots.push(root);
  await writeFile(join(root, "index.ts"), "export const value = 1;\n");
  const journal = await PatchJournal.create(root);
  await expect(journal.record({ taskId: "bad", changes: [{ path: "index.ts", before: "1", after: "2" }] }, { accepted: false, check: "target", reason: "unresolved" })).rejects.toThrow(/verified|accepted/i);
  await expect(journal.materialize(["unknown"])).rejects.toThrow(/unknown/i);
  await expect(PatchJournal.create(root)).rejects.toThrow(/existing/i);
});
