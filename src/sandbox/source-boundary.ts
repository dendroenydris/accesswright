import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { isSourcePath, PatchSchema } from "../types/schemas.js";
import type { Patch } from "../types/schemas.js";

const excludedDirectories = new Set([".git", ".next", "node_modules", ".accesswright", ".aws", ".ssh", ".gnupg", ".config", "coverage", "dist"]);
const privateFile = /^(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.netrc|\.pypirc|\.DS_Store|\._.*|AGENTS\.md)$/i;
const credentialFile = /(?:\.(?:pem|key|p12|pfx|keystore)$|(?:^|[-_.])(?:credentials?|secrets?)(?:[-_.]|$))/i;

/** Copies inputs only; neither executes repository code nor follows symbolic links. */
export async function copyTargetSnapshot(source: string, destination: string): Promise<void> {
  const root = await realpath(source);
  const target = resolve(destination);
  if (target === root || target.startsWith(`${root}${sep}`)) {
    throw new Error("Snapshot destination must be outside the source repository");
  }
  async function copyDirectory(from: string, to: string): Promise<void> {
    await mkdir(to, { recursive: true });
    const entries = (await readdir(from, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || excludedDirectories.has(entry.name) || privateFile.test(entry.name) || credentialFile.test(entry.name)) continue;
      const input = join(from, entry.name), output = join(to, entry.name);
      if (entry.isDirectory()) await copyDirectory(input, output);
      else if (entry.isFile()) {
        const stat = await lstat(input);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Input changed during snapshot creation");
        await copyFile(input, output, constants.COPYFILE_EXCL);
      }
    }
  }
  await copyDirectory(root, target);
}

export async function resolveSafeSource(root: string, path: string): Promise<string> {
  if (!isSourcePath(path)) throw new Error(`Not an editable source path: ${path}`);
  const base = await realpath(root);
  const parts = path.split("/");
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic-link source: ${path}`);
  }
  const resolved = await realpath(current);
  if (!resolved.startsWith(`${base}${sep}`) || !(await lstat(resolved)).isFile()) {
    throw new Error(`Source must be a regular file inside the repository: ${path}`);
  }
  return resolved;
}

/** This error certifies that no source mutation remains. An uncertain rollback must not use this type. */
export class SourcePatchRejectedError extends Error {
  constructor(message: string) { super(message); this.name = "SourcePatchRejectedError"; }
}

async function writeCompleteSource(handle: Awaited<ReturnType<typeof open>>, text: string): Promise<void> {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten <= 0) throw new Error("Source write made no progress");
    offset += bytesWritten;
  }
  await handle.truncate(bytes.length);
  await handle.sync();
}

/** Unique exact excerpts support bounded LLM context; ambiguous or stale edits fail closed. */
export async function applySourcePatch(root: string, input: Patch): Promise<Patch> {
  const patch = PatchSchema.parse(input);
  const handles: Array<{ path: string; handle: Awaited<ReturnType<typeof open>>; before: string; after: string }> = [];
  let writing = false;
  try {
    for (const change of patch.changes) {
      const path = await resolveSafeSource(root, change.path);
      const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        const before = await handle.readFile("utf8");
        const offset = before.indexOf(change.before);
        if (before !== change.before && (change.before.length === 0 || offset < 0 || before.indexOf(change.before, offset + 1) >= 0)) {
          throw new Error(`Patch requires a unique exact source match: ${change.path}`);
        }
        const after = before.slice(0, offset) + change.after + before.slice(offset + change.before.length);
        handles.push({ path: change.path, handle, before, after });
      } catch (error) { await handle.close(); throw error; }
    }
    // Recheck every open inode before starting the transaction.
    for (const item of handles) {
      const current = Buffer.alloc((await item.handle.stat()).size);
      await item.handle.read(current, 0, current.length, 0);
      if (current.toString("utf8") !== item.before) throw new Error(`Source changed before application: ${item.path}`);
    }
    writing = true;
    for (const item of handles) {
      await writeCompleteSource(item.handle, item.after);
    }
    return { taskId: patch.taskId, changes: handles.map(({ path, before, after }) => ({ path, before, after })) };
  } catch (error) {
    if (writing) {
      try { for (const item of handles) await writeCompleteSource(item.handle, item.before); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Source rollback failed; verification must abort", { cause: rollbackError }); }
    }
    throw new SourcePatchRejectedError(error instanceof Error ? error.message : "Source patch was rejected before application");
  } finally { await Promise.all(handles.map(item => item.handle.close())); }
}
