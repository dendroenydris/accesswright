import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { applyTransferredPatch } from "../../src/sandbox/source-transfer.js";
import { SourcePatchRejectedError } from "../../src/sandbox/source-boundary.js";

it("restores every host and container source after a partial transfer failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-transfer-"));
  const remote = new Map([["a.ts", "before-a"], ["b.ts", "before-b"]]);
  let transfers = 0;
  try {
    await writeFile(join(root, "a.ts"), "before-a"); await writeFile(join(root, "b.ts"), "before-b");
    await expect(applyTransferredPatch(root, { taskId: "fixture", changes: [
      { path: "a.ts", before: "before-a", after: "after-a" }, { path: "b.ts", before: "before-b", after: "after-b" },
    ] }, async path => {
      transfers += 1;
      if (transfers === 2) throw new Error("second copy failed");
      remote.set(path, await readFile(join(root, path), "utf8"));
    })).rejects.toBeInstanceOf(SourcePatchRejectedError);
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("before-a");
    expect(await readFile(join(root, "b.ts"), "utf8")).toBe("before-b");
    expect([...remote.values()]).toEqual(["before-a", "before-b"]);
    expect(transfers).toBe(4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not classify an uncertain rollback as safely rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-transfer-unsafe-"));
  try {
    await mkdir(join(root, "src")); await writeFile(join(root, "src/a.ts"), "before");
    let failure: unknown;
    try { await applyTransferredPatch(root, { taskId: "fixture", changes: [{ path: "src/a.ts", before: "before", after: "after" }] }, () => Promise.reject(new Error("transport unavailable"))); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).not.toBeInstanceOf(SourcePatchRejectedError);
  } finally { await rm(root, { recursive: true, force: true }); }
});
