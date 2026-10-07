import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Patch } from "../types/schemas.js";
import { listSnapshotFiles } from "../runner/patch-journal.js";
import { copyTargetSnapshot, applySourcePatch } from "./source-boundary.js";

async function fingerprint(snapshot: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of await listSnapshotFiles(snapshot)) {
    hash.update(path); hash.update("\0");
    const contents = createHash("sha256");
    const stream: AsyncIterable<unknown> = createReadStream(join(snapshot, path));
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected source stream chunk");
      contents.update(chunk);
    }
    hash.update(contents.digest());
  }
  return hash.digest("hex");
}

/** A digest of the exact inputs verified in Docker, not merely the files that happen to be patched. */
export class SourceBaseline {
  private readonly root: string;
  private readonly tempRoot: string;
  private readonly digest: string;
  private constructor(root: string, tempRoot: string, digest: string) { this.root = root; this.tempRoot = tempRoot; this.digest = digest; }

  static async fromSnapshot(originalRoot: string, snapshotRoot: string, tempRoot: string): Promise<SourceBaseline> {
    return new SourceBaseline(originalRoot, tempRoot, await fingerprint(snapshotRoot));
  }

  static async capture(root: string, tempRoot: string): Promise<SourceBaseline> {
    await mkdir(tempRoot, { recursive: true });
    const snapshot = await mkdtemp(join(tempRoot, "baseline-input-"));
    try { await copyTargetSnapshot(root, snapshot); return await this.fromSnapshot(root, snapshot, tempRoot); }
    finally { await rm(snapshot, { recursive: true, force: true }); }
  }

  async assertUnchanged(): Promise<void> {
    const snapshot = await mkdtemp(join(this.tempRoot, "current-input-"));
    try {
      await copyTargetSnapshot(this.root, snapshot);
      if (await fingerprint(snapshot) !== this.digest) throw new Error("Repository inputs changed during verification; concurrent edits were preserved");
    } finally { await rm(snapshot, { recursive: true, force: true }); }
  }

  async apply(patch: Patch): Promise<void> {
    await this.assertUnchanged();
    // The source writer performs an additional exact-content preflight on every changed file.
    await applySourcePatch(this.root, patch);
  }
}
