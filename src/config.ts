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
  maxImageBytes: 4 * 1024 * 1024,
  providerTimeoutMs: 60000,
  processKillGraceMs: 5000,
  gitReadTimeoutMs: 30000,
  sourceCheckoutTimeoutMs: 180000,
  sourceCheckoutDiagnosticBytes: 4000000,
  sourceCheckoutMaxFiles: 50000,
  sourceCheckoutMaxBytes: 250 * 1024 * 1024,
  githubApiVersion: "2026-03-10",
  githubHttpTimeoutMs: 15000,
  githubResponseMaxBytes: 64 * 1024,
  githubJwtClockSkewSeconds: 60,
  githubJwtTtlSeconds: 540,
  githubMinRsaBits: 2048,
  googleMetadataTimeoutMs: 5000,
  googleMetadataMaxResponseBytes: 8192,
  googleMetadataMaxTokenChars: 4096,
  googleMetadataMaxLifetimeSeconds: 3600,
  googleMetadataRefreshSkewSeconds: 60,
  googleIdentityMaxTokenBytes: 16 * 1024,
  hostedServicePort: 8080,
  judgeCalibrationMinFixes: 100,
  judgeCalibrationMinKappa: 0.6,
  judgeCalibrationMaxFixes: 10000,
  judgeCalibrationInputMaxBytes: 2 * 1024 * 1024,
  naturalCasesMaxFindings: 10000,
  naturalCasesInputMaxBytes: 2 * 1024 * 1024,
  naturalAuditTargetPatches: 50,
  secondCheckerMaxResults: 20000,
  operationMaxRecords: 10000,
  operationInputMaxBytes: 2 * 1024 * 1024,
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
  hostedHttpRequestTimeoutMs: 30000,
  hostedHttpHeadersTimeoutMs: 15000,
  hostedMaxContextBytes: 64 * 1024,
  hostedMaxPatchBodyBytes: 6 * 1024 * 1024,
  hostedMaxPatchResponseBytes: 512 * 1024,
  hostedMaxCandidateBodyBytes: 6 * 1024 * 1024,
  hostedMaxCandidateObjectBytes: 6 * 1024 * 1024 + 4096,
  hostedMaxCandidateResponseBytes: 4096,
  hostedMaxInputBodyBytes: 20 * 1024 * 1024,
  hostedMaxInputBytes: 12 * 1024 * 1024,
  hostedMaxInputFiles: 5000,
  hostedMaxInputPathChars: 512,
  hostedMaxStagedCandidates: 20,
  hostedVerificationDeadlineSeconds: 1800,
  hostedJobDispatchDeadlineSeconds: 30,
  hostedDispatchResponseMaxBytes: 12000,
  cloudRunResponseMaxBytes: 12000,
  cloudRunExecutionPageSize: 25,
  cloudRunExecutionMaxListPages: 40,
  hostedExpiryDeadlineSeconds: 30,
  hostedMaxFeedbackChars: 4096,
  hostedMaxImages: 1,
  hostedTokenEstimateOverhead: 8192,
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
