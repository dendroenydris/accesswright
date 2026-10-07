import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { copyTargetSnapshot } from "../sandbox/source-boundary.js";

import { instrumentNextWorkspace } from "./instrumentation.js";

export async function createDisposableWorkspace(
  sourceRoot: string,
  tempRoot: string,
  pluginModuleUrl?: string,
): Promise<string> {
  await mkdir(tempRoot, { recursive: true });
  const destination = await mkdtemp(join(tempRoot, "workspace-"));

  await copyTargetSnapshot(sourceRoot, destination);

  await instrumentNextWorkspace(destination, pluginModuleUrl);
  return destination;
}
