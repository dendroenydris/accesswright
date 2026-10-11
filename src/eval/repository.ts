import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { execa } from "execa";
import { z } from "zod";

export function pinnedClonePlan(repository: string, sha: string) {
  z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).parse(repository);
  z.string().regex(/^[a-f0-9]{40}$/).parse(sha);
  return {
    config: ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-c", "protocol.file.allow=never", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false"],
    fetch: ["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", `https://github.com/${repository}.git`, sha],
    checkout: ["checkout", "--detach", sha],
  };
}

export function isVerifiedTransportExtra(status: string, path: string, header: Uint8Array): boolean {
  return status === "??" && !path.split("/").some(part => !part || part === "." || part === "..") && !path.includes("\\") && basename(path).startsWith("._") &&
    Buffer.from(header.subarray(0, 8)).equals(Buffer.from([0, 5, 22, 7, 0, 2, 0, 0]));
}

export async function hasSourceChanges(cwd: string, status: string, describeTracked: (path: string) => Promise<string>): Promise<boolean> {
  const root = await realpath(cwd);
  for (const record of status.split("\0").filter(Boolean)) {
    const kind = record.slice(0, 2), path = record.slice(3);
    if ((kind !== " M" && kind !== "??") || !path || path.split("/").some(part => !part || part === "." || part === "..") || path.includes("\\")) return true;
    if (kind === "??" && !basename(path).startsWith("._")) return true;
    const absolute = await realpath(join(root, path));
    if (!absolute.startsWith(`${root}${sep}`)) return true;
    if (!(await lstat(join(root, path))).isFile()) return true;
    const file = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile()) return true;
      if (kind === " M") {
        const raw = z.string().max(8192).parse(await describeTracked(path));
        const diff = /^:(100644|100755) (100644|100755) ([a-f0-9]{40}) 0{40} M\0([^\0]+)\0$/.exec(raw);
        if (!diff || diff[1] !== diff[2] || diff[4] !== path) return true;
        const hash = createHash("sha1").update(`blob ${info.size}\0`);
        for await (const chunk of file.createReadStream({ autoClose: false }) as AsyncIterable<Uint8Array>) hash.update(chunk);
        if (hash.digest("hex") !== diff[3]) return true;
        continue;
      }
      const header = Buffer.alloc(8);
      await file.read(header, 0, 8, 0);
      if (!isVerifiedTransportExtra(kind, path, header)) return true;
    } finally { await file.close(); }
  }
  return false;
}

/** One immutable source cache per SHA. Never install or execute downloaded project code on the host. */
export async function fetchPinnedRepository(cacheRoot: string, repository: string, sha: string): Promise<string> {
  const plan = pinnedClonePlan(repository, sha);
  const key = createHash("sha256").update(`${repository.toLowerCase()}@${sha}`).digest("hex");
  await mkdir(cacheRoot, { recursive: true });
  const path = join(cacheRoot, key);
  const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_ALLOW_PROTOCOL: "https" };
  const git = async (cwd: string, args: string[]) => (await execa("git", [...plan.config, ...args], { cwd, env: environment, extendEnv: false, timeout: 180000, maxBuffer: 4000000 })).stdout;
  const verify = async (cwd: string) => {
    const info = await lstat(cwd);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Repository cache must be a regular directory");
    const status = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if ((await git(cwd, ["rev-parse", "HEAD"])).trim() !== sha || await hasSourceChanges(cwd, status,
      path => git(cwd, ["diff", "--raw", "-z", "--no-abbrev", "--no-ext-diff", "--no-textconv", sha, "--", path]))) throw new Error("Frozen repository cache changed; existing files were preserved");
  };
  try { await lstat(path); await verify(path); return path; }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const temporary = await mkdtemp(join(cacheRoot, ".fetch-"));
  try {
    await git(temporary, ["init", "--initial-branch=accesswright-eval"]);
    await git(temporary, plan.fetch);
    await git(temporary, plan.checkout);
    await verify(temporary);
    let bytes = 0, files = 0;
    const inspect = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        const target = join(directory, entry.name);
        if (entry.isDirectory()) await inspect(target);
        else if (entry.isFile()) { files += 1; bytes += (await lstat(target)).size; }
        if (files > 50000 || bytes > 250 * 1024 * 1024) throw new Error("Repository exceeds the bounded source-corpus size");
      }
    };
    await inspect(temporary);
    await rename(temporary, path);
    return path;
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}
