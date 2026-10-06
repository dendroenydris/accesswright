import { z } from "zod";

export const LlmProviderNameSchema = z.enum([
  "openai",
  "anthropic",
  "deepseek",
  "openai-compatible",
]);

export const LlmModelConfigSchema = z
  .object({
    provider: LlmProviderNameSchema,
    id: z.string().min(1),
    reasoningEffort: z.string().min(1).optional(),
    baseURL: z.string().url().optional(),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
  })
  .strict();

export type LlmModelConfig = z.infer<typeof LlmModelConfigSchema>;

export const AccesswrightConfigSchema = z
  .object({
    routes: z.array(z.string().startsWith("/")).default([]),
    ignore: z
      .object({
        rules: z.array(z.string().min(1)).default([]),
        paths: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ rules: [], paths: [] }),
    scan: z
      .object({
        mobile: z.boolean().default(true),
        darkScheme: z.boolean().default(false),
      })
      .strict()
      .default({ mobile: true, darkScheme: false }),
    maxCostUsd: z.number().nonnegative().optional(),
    model: LlmModelConfigSchema.optional(),
    escalationModel: LlmModelConfigSchema.optional(),
    offline: z.boolean().default(false),
  })
  .strict();

export type AccesswrightConfig = z.infer<typeof AccesswrightConfigSchema>;

export const SourceLocationSchema = z
  .object({
    file: z.string().min(1),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
  })
  .strict();

export const ViolationSchema = z
  .object({
    ruleId: z.string().min(1),
    impact: z.string().nullable(),
    route: z.string().startsWith("/"),
    target: z.array(z.string()).min(1),
    html: z.string(),
    failureSummary: z.string().nullable(),
    source: SourceLocationSchema.nullable(),
  })
  .strict();

export type SourceLocation = z.infer<typeof SourceLocationSchema>;
export type Violation = z.infer<typeof ViolationSchema>;

export const FixKindSchema = z.enum(["syntactic", "semantic", "layout", "global", "human"]);
export const FixRouteSchema = z.enum(["codemod", "optimizer", "llm", "human"]);

export const FixTaskSchema = z
  .object({
    id: z.string().min(1),
    ruleId: z.string().min(1),
    criterion: z.string().min(1),
    kind: FixKindSchema,
    route: FixRouteSchema,
    source: SourceLocationSchema.nullable(),
    routes: z.array(z.string().startsWith("/")).min(1),
    violations: z.array(ViolationSchema).min(1),
  })
  .strict();

export type FixKind = z.infer<typeof FixKindSchema>;
export type FixRoute = z.infer<typeof FixRouteSchema>;
export type FixTask = z.infer<typeof FixTaskSchema>;

const forbiddenSourcePath = [
  /(^|\/)package\.json$/i,
  /(^|\/)(?:npm-shrinkwrap\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i,
  /(^|\/)tsconfig(?:\.[^/]+)?\.json$/i,
  /(^|\/)next\.config\.[^/]+$/i,
  /(^|\/)vite\.config\.[^/]+$/i,
  /(^|\/)webpack\.config\.[^/]+$/i,
  /(^|\/)\.github\//i,
];

function isSourcePath(path: string): boolean {
  return !forbiddenSourcePath.some((pattern) => pattern.test(path));
}

export const PatchChangeSchema = z
  .object({
    path: z.string().min(1).refine(isSourcePath, {
      message: "Patch path must be a source file, not a manifest, lockfile, build config, or CI file",
    }),
    before: z.string(),
    after: z.string(),
  })
  .strict();

export const PatchSchema = z
  .object({
    taskId: z.string().min(1),
    changes: z.array(PatchChangeSchema).min(1),
  })
  .strict();

export type Patch = z.infer<typeof PatchSchema>;
