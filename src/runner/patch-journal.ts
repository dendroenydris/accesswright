import { lstat, mkdtemp, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { execa } from "execa";
import { PatchSchema } from "../types/schemas.js";
import type { Patch } from "../types/schemas.js";
import { resolveSafeSource } from "../sandbox/source-boundary.js";
import { removePlatformMetadata } from "../sandbox/platform-metadata.js";
import type { PerPatchVerificationResult } from "../verifier/per-patch.js";

export interface JournalFix { id: string; commit: string; patch: Patch }
export interface MaterializedFixes { path: string; replayFailures: string[]; close(): Promise<void> }

/** Enumerates regular files without following target-controlled symlinks. */
export async function listSnapshotFiles(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || [".git", "node_modules", ".next", ".accesswright"].includes(entry.name) || entry.name.startsWith("._")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listSnapshotFiles(root, path));
    else if (entry.isFile()) result.push(relative(root, path).split(sep).join("/"));
  }
  return result;
}

const gitOptions = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", "-c", "user.name=accesswright", "-c", "user.email=accesswright@localhost"];
function gitEnvironment(): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

/** Own temporary Git history only. Never initializes or switches the user's Git workspace. */
export class PatchJournal {
  readonly root: string;
  readonly baseline: string;
  readonly fixes: JournalFix[] = [];

  private constructor(root: string, baseline: string) { this.root = root; this.baseline = baseline; }

  private static async git(root: string, args: readonly string[], raw = false): Promise<string> {
    const result = await execa("git", [...gitOptions, ...args], { cwd: root, env: gitEnvironment(), extendEnv: false, stripFinalNewline: !raw });
    return raw ? result.stdout : result.stdout.trim();
  }

  static async create(root: string): Promise<PatchJournal> {
    try { await lstat(join(root, ".git")); throw new Error("Refusing an existing Git workspace"); }
    catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const files = await listSnapshotFiles(root);
    if (files.length === 0) throw new Error("A source snapshot is required for the patch journal");
    await this.git(root, ["init", "--initial-branch=accesswright-journal"]);
    for (let start = 0; start < files.length; start += 100) {
      await this.git(root, ["add", "--force", "--", ...files.slice(start, start + 100)]);
    }
    await this.git(root, ["commit", "-m", "chore: record isolated source baseline"]);
    return new PatchJournal(root, await this.git(root, ["rev-parse", "HEAD"]));
  }

  async record(input: Patch, verification: PerPatchVerificationResult): Promise<JournalFix> {
    if (!verification.accepted || verification.check !== "ok") throw new Error("Only an accepted, verified patch may enter the journal");
    const patch = PatchSchema.parse(input);
    if (this.fixes.some(fix => fix.id === patch.taskId)) throw new Error("A fix group was already recorded");
    for (const change of patch.changes) {
      const source = await readFile(await resolveSafeSource(this.root, change.path), "utf8");
      if (source !== change.after) throw new Error(`Verified source changed before recording: ${change.path}`);
    }
    const changed = (await PatchJournal.git(this.root, ["diff", "--name-only"])).split("\n").filter(Boolean);
    if (changed.some(path => !patch.changes.some(change => change.path === path))) throw new Error("Unrelated changes are present in the isolated patch journal");
    await PatchJournal.git(this.root, ["add", "--", ...patch.changes.map(change => change.path)]);
    await PatchJournal.git(this.root, ["commit", "-m", "fix: apply verified accessibility repair", "-m", `Accesswright-Task: ${patch.taskId}`]);
    const fix = { id: patch.taskId, patch, commit: await PatchJournal.git(this.root, ["rev-parse", "HEAD"]) };
    this.fixes.push(fix);
    return fix;
  }

  async exportPatches(fixIds: readonly string[]): Promise<Patch[]> {
    const selected = await this.materialize(fixIds);
    try {
      if (selected.replayFailures.length > 0) throw new Error("Final verified groups do not replay cleanly");
      const ordered = this.fixes.filter(fix => fixIds.includes(fix.id));
      const commits = (await PatchJournal.git(selected.path, ["rev-list", "--reverse", `${this.baseline}..HEAD`])).split("\n").filter(Boolean);
      if (ordered.length !== commits.length) throw new Error("Final group history is inconsistent");
      const exported: Patch[] = [];
      for (const [index, commit] of commits.entries()) {
        const fix = ordered[index];
        if (!fix) throw new Error("Missing verified group identity");
        const changes: Patch["changes"] = [];
        for (const change of fix.patch.changes) {
          const before = await PatchJournal.git(selected.path, ["show", `${commit}^:${change.path}`], true);
          const after = await PatchJournal.git(selected.path, ["show", `${commit}:${change.path}`], true);
          if (before !== after) changes.push({ path: change.path, before, after });
        }
        exported.push(PatchSchema.parse({ taskId: fix.id, changes }));
      }
      return exported;
    } finally { await selected.close(); }
  }

  async materialize(fixIds: readonly string[]): Promise<MaterializedFixes> {
    if (new Set(fixIds).size !== fixIds.length || fixIds.some(id => !this.fixes.some(fix => fix.id === id))) throw new Error("Unknown or duplicate fix identifier");
    const path = await mkdtemp(join(dirname(this.root), "selected-fixes-"));
    await PatchJournal.git(this.root, ["worktree", "add", "--detach", path, this.baseline]);
    const replayFailures: string[] = [];
    try {
      for (const fix of this.fixes.filter(fix => fixIds.includes(fix.id))) {
        try { await PatchJournal.git(path, ["cherry-pick", fix.commit]); }
        catch {
          await PatchJournal.git(path, ["cherry-pick", "--abort"]);
          replayFailures.push(fix.id);
        }
      }
      return { path, replayFailures, close: async () => {
        await removePlatformMetadata(path);
        await PatchJournal.git(this.root, ["worktree", "remove", path]);
      } };
    } catch (error) {
      await PatchJournal.git(this.root, ["worktree", "remove", path]);
      throw error;
    }
  }
}
