import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { AccesswrightConfigSchema } from "./types/schemas.js";
import type { AccesswrightConfig } from "./types/schemas.js";

export const defaults = Object.freeze({
  dockerImage: "mcr.microsoft.com/playwright:v1.63.0-noble",
  desktop: { width: 1280, height: 720 },
  mobile: { width: 320, height: 800 },
  maxRoutes: 50,
  crawlDepth: 2,
  maxTasks: 20,
  maxAttempts: 3,
  maxOutputTokens: 4096,
  maxTaskTokens: 64000,
  maxRunCostUsd: 0,
  contrastRatio: 4.5,
  configMaxBytes: 65536,
  maxContextFiles: 12,
  maxContextBytes: 64000,
  providerTimeoutMs: 60000,
  dockerControlTimeoutMs: 120000,
  dockerCopyTimeoutMs: 600000,
  readyTimeoutMs: 120000,
  productionCheckTimeoutMs: 300000,
  installTimeoutMs: 600000,
  maximumDiagnosticBytes: 32 * 1024 * 1024,
  targetPort: 3000,
  browserNavigationTimeoutMs: 90000,
  hostedDefaultMaxRequests: 3,
  hostedMaxRequests: 20,
  hostedDefaultTtlSeconds: 900,
  hostedMinTtlSeconds: 30,
  hostedMaxTtlSeconds: 3600,
  hostedMaxOutputTokens: 8192,
  hostedGlobalBudgetPrefix: "global-",
  hostedInstallationBudgetPrefix: "installation-",
  firestoreRecordMaxBytes: 8192,
  firestoreResponseMaxBytes: 256 * 1024,
  firestorePageSize: 25,
  firestoreMaxListPages: 40,
  firestoreMaxAtomicRecords: 3,
});

export async function loadConfig(
  repoPath: string,
  overrides: Partial<AccesswrightConfig> = {},
): Promise<AccesswrightConfig> {
  let text: string;
  try {
    text = await readFile(join(repoPath, ".accesswright.yml"), "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return AccesswrightConfigSchema.parse(overrides);
    }
    throw error;
  }
  if (Buffer.byteLength(text) > defaults.configMaxBytes) {
    throw new Error("Configuration exceeds the maximum size");
  }
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Invalid YAML configuration: ${document.errors.map(error => error.message).join("; ")}`);
  }
  const data: unknown = document.toJS({ maxAliasCount: 0 });
  const config = AccesswrightConfigSchema.parse(data ?? {});
  return AccesswrightConfigSchema.parse({ ...config, ...overrides });
}

export function isIgnoredPath(path: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => {
    const expression = pattern.split("**").map(part =>
      part.split("*").map(piece => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"),
    ).join(".*");
    return new RegExp(`^${expression}$`).test(path);
  });
}
