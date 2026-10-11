import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import { z } from "zod";

it("packs compiled runtime and commands while excluding source checkouts, internal documents and private files", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-package-boundary-"));
  try {
    await writeFile(join(root, "package.json"), await readFile("package.json"));
    for (const path of ["dist/src/cli.js", "dist/src/mcp/server.js", "dist/src/core/repository.js", "dist/src/core/repository.d.ts", "dist/src/core/repair.js", "dist/src/core/repair.d.ts", "README.md", "LICENSE", "CHANGELOG.md",
      "src/cli.ts", "test/private-fixture.ts", "app/private-dashboard.ts", "eval/private-results.json", "docs/internal.md", "AGENTS.md", ".accesswright/spend.json", ".env", "private.key", "dist/test/private-fixture.js"]) {
      await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), "fixture-only\n");
    }
    await writeFile(join(root, "empty-npmrc"), ""); await writeFile(join(root, "empty-global-npmrc"), "");
    const result = await execa("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, extendEnv: false,
      env: { PATH: process.env.PATH ?? "", HOME: root, npm_config_cache: join(root, "cache"),
        npm_config_userconfig: join(root, "empty-npmrc"), npm_config_globalconfig: join(root, "empty-global-npmrc") } });
    const packs = z.array(z.object({ files: z.array(z.object({ path: z.string() })) })).length(1).parse(JSON.parse(result.stdout) as unknown);
    const paths = packs[0]?.files.map(file => file.path).sort();
    expect(paths).toEqual(["CHANGELOG.md", "LICENSE", "README.md", "dist/src/cli.js", "dist/src/core/repository.js", "dist/src/core/repository.d.ts", "dist/src/core/repair.d.ts", "dist/src/core/repair.js", "dist/src/mcp/server.js", "package.json"].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});
