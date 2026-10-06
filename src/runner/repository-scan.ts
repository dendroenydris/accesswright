import { readdir, rm } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

import { z } from "zod";

import {
  discoverFileRoutes,
  materializeRoutes,
} from "../routes/discovery.js";
import { dockerExec } from "../sandbox/docker.js";
import { ViolationSchema } from "../types/schemas.js";
import type { Violation } from "../types/schemas.js";
import { startCopiedDevServer } from "./dev-server.js";
import { createDisposableWorkspace } from "./workspace.js";

const crawlOutputSchema = z
  .object({
    paths: z.array(z.string().startsWith("/")),
  })
  .strict();

const pageScanSchema = z
  .object({
    violations: z.array(ViolationSchema),
    incomplete: z.array(ViolationSchema),
    ariaTree: z.string(),
    screenshotPath: z.string().nullable(),
  })
  .strict();

const scanOutputSchema = z
  .object({
    results: z.array(pageScanSchema),
  })
  .strict();

export interface RepositoryScanOptions {
  tempRoot: string;
  image: string;
  accesswrightNodeModules: string;
  accesswrightRuntime: string;
  npmCache: string;
  port?: number;
}

export interface RepositoryScanResult {
  violations: Violation[];
  incomplete: Violation[];
  ariaTrees: Map<string, string>;
}

function excludedEntry(relativePath: string): boolean {
  const segments = relativePath.split(sep);
  const first = segments[0];
  return (
    first === ".git" ||
    first === ".next" ||
    first === "node_modules" ||
    first === ".accesswright" ||
    segments.some(
      (segment) => segment.startsWith("._") || segment === ".DS_Store",
    )
  );
}

async function listProjectFiles(
  root: string,
  current = root,
): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const projectRelative = relative(root, absolute);
    if (excludedEntry(projectRelative)) continue;

    if (entry.isDirectory()) {
      files.push(...(await listProjectFiles(root, absolute)));
    } else if (entry.isFile()) {
      files.push(projectRelative.split(sep).join("/"));
    }
  }
  return files;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error("Sandbox scanner returned invalid JSON", { cause: error });
  }
}

export async function scanRepository(
  repoPath: string,
  options: RepositoryScanOptions,
): Promise<RepositoryScanResult> {
  const files = await listProjectFiles(repoPath);
  const fileRoutes = discoverFileRoutes(files);
  if (fileRoutes.length === 0) {
    throw new Error("No Next.js App Router or Pages Router routes were found");
  }

  const workspaceRoot = join(options.tempRoot, "scan-workspaces");
  const workspace = await createDisposableWorkspace(repoPath, workspaceRoot);
  const port = options.port ?? 3000;
  const containerName = `accesswright-${basename(workspace)
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .slice(0, 50)}`;
  const server = await startCopiedDevServer({
    workspace,
    image: options.image,
    accesswrightNodeModules: options.accesswrightNodeModules,
    accesswrightRuntime: options.accesswrightRuntime,
    npmCache: options.npmCache,
    containerName,
    port,
  });

  try {
    const containerBaseUrl = `http://127.0.0.1:${port}`;
    const crawlStdout = await dockerExec(containerName, [
      "node",
      "/accesswright/dist/src/scanner/container-entry.js",
      "crawl",
      containerBaseUrl,
      JSON.stringify({ maxDepth: 2, maxPages: 50 }),
    ]);
    const crawl = crawlOutputSchema.parse(parseJson(crawlStdout));
    const routes = [
      ...new Set(
        materializeRoutes(fileRoutes, crawl.paths).map((route) => route.urlPath),
      ),
    ];
    if (routes.length === 0) {
      throw new Error("No concrete routes were available to scan");
    }

    const scanStdout = await dockerExec(containerName, [
      "node",
      "/accesswright/dist/src/scanner/container-entry.js",
      "scan",
      containerBaseUrl,
      JSON.stringify(routes),
      "/workspace/.accesswright/screenshots",
    ]);
    const scan = scanOutputSchema.parse(parseJson(scanStdout));
    if (scan.results.length !== routes.length) {
      throw new Error(
        `Scanner returned ${scan.results.length} pages for ${routes.length} routes`,
      );
    }

    const ariaTrees = new Map<string, string>();
    for (const [index, result] of scan.results.entries()) {
      const route = routes[index];
      if (route === undefined) {
        throw new Error("Scanner route/result alignment failed");
      }
      ariaTrees.set(route, result.ariaTree);
    }

    return {
      violations: scan.results.flatMap((result) => result.violations),
      incomplete: scan.results.flatMap((result) => result.incomplete),
      ariaTrees,
    };
  } finally {
    await server.stop().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}
