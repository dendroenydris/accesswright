import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { isMainModule } from "../../src/entrypoint.js";

it("recognizes npm symlink commands without treating another or missing file as the main module", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aw-main-module-")));
  try {
    const cli = join(root, "cli.js"), link = join(root, "accesswright"), other = join(root, "other.js");
    await writeFile(cli, ""); await writeFile(other, ""); await symlink(cli, link);
    const url = pathToFileURL(cli).href;
    expect(await isMainModule(url, cli)).toBe(true); expect(await isMainModule(url, link)).toBe(true);
    expect(await isMainModule(url, other)).toBe(false); expect(await isMainModule(url, join(root, "missing"))).toBe(false);
    expect(await isMainModule(url, join(other, "invalid"))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
