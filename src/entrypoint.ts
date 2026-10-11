import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** npm commands are symlinks; compare the actual executable file before running main. */
export async function isMainModule(moduleUrl: string, invokedPath = process.argv[1]): Promise<boolean> {
  if (invokedPath === undefined) return false;
  try { return moduleUrl === pathToFileURL(await realpath(resolve(invokedPath))).href; }
  catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))) return false;
    throw error;
  }
}
