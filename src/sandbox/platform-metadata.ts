import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Remove only OS transport metadata, never source files or diagnostics from the compiler. */
export async function removePlatformMetadata(directory: string): Promise<number> {
  let removed = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isFile() && (entry.name.startsWith("._") || entry.name === ".DS_Store")) {
      await rm(path); removed += 1;
    } else if (entry.isDirectory() && !["node_modules", ".git", ".next"].includes(entry.name)) {
      removed += await removePlatformMetadata(path);
    }
  }
  return removed;
}
