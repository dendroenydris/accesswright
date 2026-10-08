import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { readEvaluationCells } from "../../src/eval/results.js";

it("reconstructs partial results without executing models and rejects a symlink or malformed cell", async () => {
  const root=await mkdtemp(join(tmpdir(),"aw-results-"));
  try {
    await writeFile(join(root,"manifest.json"),"{}");
    await writeFile(join(root,`${"a".repeat(64)}-reference.json`),"{}");
    expect(await readEvaluationCells(root)).toEqual([]);
    const path=join(root,`${"b".repeat(64)}.json`);
    await symlink(join(root,"manifest.json"),path);
    await expect(readEvaluationCells(root)).rejects.toThrow(/regular|symbolic/);
    await rm(path); await writeFile(path,"{}");
    await expect(readEvaluationCells(root)).rejects.toThrow();
  } finally { await rm(root,{recursive:true,force:true}); }
});
