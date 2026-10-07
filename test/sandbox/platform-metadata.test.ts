import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { removePlatformMetadata } from "../../src/sandbox/platform-metadata.js";

it("removes transferred AppleDouble metadata without suppressing source errors or traversing symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-platform-"));
  try {
    await mkdir(join(root,"app")); await mkdir(join(root,"outside"));
    await writeFile(join(root,"app/page.tsx"), "actual invalid source is not silently deleted");
    await writeFile(join(root,"app/._page.tsx"), new Uint8Array([0,5,22,7]));
    await writeFile(join(root,"outside/._private.tsx"), "outside-marker");
    await symlink(join(root,"outside"), join(root,"app/linked"));
    expect(await removePlatformMetadata(join(root,"app"))).toBe(1);
    expect(await readdir(join(root,"app"))).toEqual(["linked","page.tsx"]);
    expect(await readFile(join(root,"app/page.tsx"),"utf8")).toContain("actual invalid source");
    expect(await readFile(join(root,"outside/._private.tsx"),"utf8")).toBe("outside-marker");
  } finally { await rm(root,{recursive:true,force:true}); }
});
