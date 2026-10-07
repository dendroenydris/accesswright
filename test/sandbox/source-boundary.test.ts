import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyTargetSnapshot, applySourcePatch } from "../../src/sandbox/source-boundary.js";
import { PatchSchema } from "../../src/types/schemas.js";

const roots: string[] = [];
async function root() { const dir = await mkdtemp(join(tmpdir(), "aw-boundary-")); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe("source and credential boundary", () => {
  it.each(["../outside.ts", "/tmp/out.ts", "C:\\outside.ts", "app/../../outside.ts", ".git/hooks/pre-commit.ts", "node_modules/pkg/index.js", ".env", "config/key.pem", "package.json", "next.config.ts", "app/eslint.config.js"])("rejects non-source path %s", (path) => {
    expect(PatchSchema.safeParse({taskId:"x",changes:[{path,before:"a",after:"b"}]}).success).toBe(false);
  });
  it("rejects duplicate changes to one file", () => {
    expect(PatchSchema.safeParse({taskId:"x",changes:[{path:"app/page.tsx",before:"a",after:"b"},{path:"app/page.tsx",before:"a",after:"c"}]}).success).toBe(false);
  });
  it("does not copy credential files, Git metadata, caches or external symlinks", async () => {
    const source = await root(), destination = await root(), outside = await root();
    await mkdir(join(source,"app")); await writeFile(join(source,"app/page.tsx"), "source");
    await writeFile(join(source,".env.local"), "SECRET=private"); await writeFile(join(source,".npmrc"), "//registry:_authToken=private");
    await mkdir(join(source,".git")); await writeFile(join(source,".git/config"), "credentials");
    await writeFile(join(outside,"private.ts"), "private"); await symlink(join(outside,"private.ts"),join(source,"app/escape.ts"));
    await copyTargetSnapshot(source,destination);
    expect(await readdir(destination)).toEqual(["app"]);
    expect(await readdir(join(destination,"app"))).toEqual(["page.tsx"]);
  });
  it("applies a unique exact excerpt but never guesses an ambiguous match", async () => {
    const dir = await root(); await writeFile(join(dir,"Button.tsx"), "before <button /> after");
    await applySourcePatch(dir, {taskId:"x",changes:[{path:"Button.tsx",before:"<button />",after:'<button aria-label="Save" />'}]});
    expect(await readFile(join(dir,"Button.tsx"),"utf8")).toContain('aria-label="Save"');
    await writeFile(join(dir,"Button.tsx"), "same same");
    await expect(applySourcePatch(dir,{taskId:"x",changes:[{path:"Button.tsx",before:"same",after:"different"}]})).rejects.toThrow(/unique|ambiguous/i);
    expect(await readFile(join(dir,"Button.tsx"),"utf8")).toBe("same same");
  });
  it("can restore a rejected candidate that temporarily emptied a file without permitting empty substring insertions", async () => {
    const dir = await root(); await writeFile(join(dir, "View.tsx"), "original source");
    const normalized = await applySourcePatch(dir, { taskId: "empty-candidate", changes: [{ path: "View.tsx", before: "original source", after: "" }] });
    await applySourcePatch(dir, { taskId: normalized.taskId, changes: normalized.changes.map(change => ({ ...change, before: change.after, after: change.before })) });
    expect(await readFile(join(dir, "View.tsx"), "utf8")).toBe("original source");
    await expect(applySourcePatch(dir, { taskId: "bad", changes: [{ path: "View.tsx", before: "", after: "overwrite" }] })).rejects.toThrow(/unique/);
  });
  it("preflights all files before writing and rejects symlink edits", async () => {
    const dir=await root(), outside=await root(); await writeFile(join(dir,"A.tsx"),"a"); await writeFile(join(outside,"B.tsx"),"b"); await symlink(join(outside,"B.tsx"),join(dir,"B.tsx"));
    await expect(applySourcePatch(dir,{taskId:"x",changes:[{path:"A.tsx",before:"a",after:"changed"},{path:"B.tsx",before:"b",after:"changed"}]})).rejects.toThrow();
    expect(await readFile(join(dir,"A.tsx"),"utf8")).toBe("a");
    expect(await readFile(join(outside,"B.tsx"),"utf8")).toBe("b");
  });
});
