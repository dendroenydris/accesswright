import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DockerRepairSession } from "../../src/runner/repair-session.js";
import { IsolatedDockerSession } from "../../src/sandbox/session.js";

afterEach(() => { vi.restoreAllMocks(); });

it.each(["invalid-manifest", "not-next", "no-routes", "missing-runtime", "failed-close"])("removes private source after %s preparation failure", async failure => {
  const root = await mkdtemp(join(tmpdir(), "aw-prepare-cleanup-"));
  const repoPath = join(root, "repo"), tempRoot = join(root, "runs"), runtimeRoot = join(root, "runtime");
  const create = vi.spyOn(IsolatedDockerSession.prototype, "create").mockRejectedValue(new Error("fixture create failure"));
  const close = vi.spyOn(IsolatedDockerSession.prototype, "close").mockResolvedValue(undefined);
  try {
    await mkdir(join(repoPath, "app"), { recursive: true });
    await writeFile(join(repoPath, "private.ts"), 'export const value = "private-source-marker";\n');
    await writeFile(join(repoPath, "package.json"), failure === "invalid-manifest" ? "{" :
      JSON.stringify({ dependencies: failure === "not-next" ? {} : { next: "16.3.8" } }));
    if (failure !== "no-routes") await writeFile(join(repoPath, "app/page.tsx"), "export default function Page() { return null; }\n");
    if (failure === "failed-close") {
      await mkdir(join(runtimeRoot, "node_modules"), { recursive: true });
      await mkdir(join(runtimeRoot, "dist/src/runner"), { recursive: true });
      await writeFile(join(runtimeRoot, "dist/src/runner/target-entry.js"), "");
      create.mockImplementation(async source => {
        const interrupted = join(dirname(source), "selected-fixes-interrupted");
        await mkdir(interrupted);
        await writeFile(join(interrupted, "private.ts"), "private-source-marker");
        throw new Error("fixture create failure");
      });
      close.mockRejectedValue(new Error("fixture close failure"));
    }
    await expect(DockerRepairSession.prepare({ repoPath, tempRoot, runtimeRoot, config: {} })).rejects.toThrow();
    if (failure === "failed-close") {
      expect(create).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } else expect(create).not.toHaveBeenCalled();
    const runs = await readdir(tempRoot);
    expect(runs).toHaveLength(1);
    const run = join(tempRoot, runs[0] ?? "");
    await expect(access(join(run, "source"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(run)).toEqual(["evidence"]);
    expect(await readFile(join(repoPath, "private.ts"), "utf8")).toContain("private-source-marker");
    const record = await readFile(join(run, "evidence/run.jsonl"), "utf8");
    expect(record).toContain('"status":"error"');
    expect(record).not.toContain("private-source-marker");
  } finally { await rm(root, { recursive: true, force: true }); }
});
