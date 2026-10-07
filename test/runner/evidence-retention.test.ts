import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { clearPrivateEvidence } from "../../src/runner/evidence-retention.js";

it("removes raw screenshots and content by default while retaining structured run metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-evidence-"));
  try {
    await writeFile(join(root,"report.json"), '{"status":"verified"}');
    await writeFile(join(root,"run.jsonl"), '{"step":"scan","status":"ok"}\n');
    await writeFile(join(root,"candidate-page.png"), "private screenshot bytes");
    await writeFile(join(root,"context.json"), '{"source":"private source"}');
    await clearPrivateEvidence(root, false);
    expect((await readdir(root)).sort()).toEqual(["report.json","run.jsonl"]);
    await writeFile(join(root,"candidate-page.png"), "explicitly retained screenshot bytes");
    await clearPrivateEvidence(root, true);
    expect(await readFile(join(root,"candidate-page.png"),"utf8")).toContain("explicitly retained");
  } finally { await rm(root,{recursive:true,force:true}); }
});
