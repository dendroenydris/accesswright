import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PatchJournal } from "../../src/runner/patch-journal.js";
import { applySourcePatch } from "../../src/sandbox/source-boundary.js";

it("exports final-selected groups without dropped source content and preserves exact whitespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-export-"));
  try {
    const original = '  export const bad = 1;\n\n\n\n\n\nexport const good = 1;\n\n';
    await writeFile(join(root, "index.ts"), original);
    const journal = await PatchJournal.create(root);
    const first = await applySourcePatch(root, { taskId: "dropped", changes: [{ path: "index.ts", before: "bad = 1", after: 'bad: number = "broken"' }] });
    await journal.record(first, { accepted: true, check: "ok", reason: null });
    const second = await applySourcePatch(root, { taskId: "accepted", changes: [{ path: "index.ts", before: "good = 1", after: "good = 2" }] });
    await journal.record(second, { accepted: true, check: "ok", reason: null });
    const exported = await journal.exportPatches(["accepted"]);
    expect(exported).toEqual([{ taskId: "accepted", changes: [{ path: "index.ts", before: original, after: original.replace("good = 1", "good = 2") }] }]);
    expect(JSON.stringify(exported)).not.toContain("broken");
    expect(await journal.exportPatches([])).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
