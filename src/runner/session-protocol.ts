import { z } from "zod";
import { defaults } from "../config.js";
import { AccesswrightConfigSchema } from "../types/schemas.js";
import { BrowserObservationSchema } from "../scanner/observations.js";

const baseUrl = z.enum(["http://accesswright-app:3000", "http://127.0.0.1:3000"]);
export const BrowserCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ready"), baseUrl, route: AccesswrightConfigSchema.shape.routes.unwrap().element }).strict(),
  z.object({ action: z.literal("crawl"), baseUrl, maxDepth: z.number().int().min(0).max(5).default(defaults.crawlDepth), maxPages: z.number().int().positive().max(defaults.maxRoutes).default(defaults.maxRoutes) }).strict(),
  z.object({ action: z.literal("scan"), baseUrl, routes: AccesswrightConfigSchema.shape.routes.unwrap().min(1).max(defaults.maxRoutes), generation: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100), mobile: z.boolean(), dark: z.boolean(), interactions: z.boolean(), ibm: z.boolean().optional() }).strict(),
]);
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;
export const BrowserScanOutputSchema = z.object({ observations: z.array(BrowserObservationSchema) }).strict();
export const CrawlOutputSchema = z.object({ paths: AccesswrightConfigSchema.shape.routes.unwrap() }).strict();
export const ProductionCheckResultSchema = z.object({
  check: z.enum(["build", "typecheck", "lint", "tests"]), argv: z.array(z.string()), available: z.boolean(),
  status: z.enum(["passed", "failed", "unavailable"]), durationMs: z.number().nonnegative(), exitCode: z.number().int().nullable(), failureIds: z.array(z.string()),
  diagnostic: z.string().max(12000).optional(),
}).strict();
export const TargetCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inspect") }).strict(),
  z.object({ action: z.literal("start"), mode: z.enum(["dev", "production"]) }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
  z.object({ action: z.literal("reset-source") }).strict(),
  z.object({ action: z.literal("checks"), checks: z.array(z.enum(["build", "typecheck", "lint", "tests"])).min(1).max(4), privateDiagnostics: z.boolean().default(false) }).strict(),
]);
export const TargetInspectionSchema = z.object({ nextVersion: z.string(), hasTypeScript: z.boolean(), processEnvironmentNames: z.array(z.string()), privateFilesPresent: z.array(z.string()) }).strict();
export const CheckOutputSchema = z.object({ checks: z.array(ProductionCheckResultSchema) }).strict();

export function targetProcessEnvironment(input: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: `/workspace/node_modules/.accesswright-tools/node_modules/.bin:${input.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    HOME: input.HOME ?? "/home/pwuser",
    CI: "1",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  if (input.NODE_ENV === "production" || input.NODE_ENV === "development") environment.NODE_ENV = input.NODE_ENV;
  return environment;
}

export function sourceRoutesForChanges(paths: readonly string[], map: Readonly<Record<string, readonly string[]>>, allRoutes: readonly string[]): string[] {
  if (paths.some(path => /(?:^|\/)(?:layout|_app|_document)\.[jt]sx?$/.test(path) || /\.(?:css|scss|sass|less)$/.test(path) || map[path] === undefined)) return [...allRoutes];
  const required = new Set(paths.flatMap(path => map[path] ?? []));
  return allRoutes.filter(route => required.has(route));
}
