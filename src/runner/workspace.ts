import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { instrumentNextWorkspace } from "./instrumentation.js";

function isExcluded(relativePath: string): boolean {
  if (relativePath.length === 0) return false;
  const segments = relativePath.split(sep);
  const firstSegment = segments[0];
  return (
    firstSegment === "node_modules" ||
    firstSegment === ".next" ||
    firstSegment === ".git" ||
    segments.some((segment) => segment.startsWith("._") || segment === ".DS_Store")
  );
}

export async function createDisposableWorkspace(
  sourceRoot: string,
  tempRoot: string,
  pluginModuleUrl?: string,
): Promise<string> {
  await mkdir(tempRoot, { recursive: true });
  const destination = await mkdtemp(join(tempRoot, "workspace-"));

  await cp(sourceRoot, destination, {
    recursive: true,
    filter: (source) => !isExcluded(relative(sourceRoot, source)),
  });

  await instrumentNextWorkspace(destination, pluginModuleUrl);
  return destination;
}
