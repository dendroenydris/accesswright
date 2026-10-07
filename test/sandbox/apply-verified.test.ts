import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SourceBaseline } from "../../src/sandbox/apply-verified.js";

it("protects other files changed while a patch was being verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-original-"));
  const temp = await mkdtemp(join(tmpdir(), "aw-baseline-"));
  try {
    await writeFile(join(root, "A.tsx"), "export const a = 1;");
    await writeFile(join(root, "B.tsx"), "export const b = 1;");
    const baseline = await SourceBaseline.capture(root, temp);
    await writeFile(join(root, "B.tsx"), "export const b = 2;");
    await expect(baseline.apply({ taskId: "verified", changes: [{ path: "A.tsx", before: "export const a = 1;", after: "export const a = 2;" }] })).rejects.toThrow(/changed|concurrent/i);
    expect(await readFile(join(root,"A.tsx"),"utf8")).toBe("export const a = 1;");
    expect(await readFile(join(root,"B.tsx"),"utf8")).toBe("export const b = 2;");
    await writeFile(join(root,"B.tsx"),"export const b = 1;");
    await baseline.apply({ taskId: "verified", changes: [{ path: "A.tsx", before: "export const a = 1;", after: "export const a = 2;" }] });
    expect(await readFile(join(root,"A.tsx"),"utf8")).toBe("export const a = 2;");
  } finally { await rm(root,{recursive:true,force:true}); await rm(temp,{recursive:true,force:true}); }
});
