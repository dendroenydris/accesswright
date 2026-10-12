import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { z } from "zod";
import { LlmModelConfigSchema } from "../types/schemas.js";

export const OperatorSchema = z.enum(["remove-alt", "break-label", "remove-button-name", "remove-link-name", "low-contrast", "invalid-aria", "remove-lang", "positive-tabindex"]);
export type Operator = z.infer<typeof OperatorSchema>;
export const experimentalEvalSystems = Object.freeze(["B2", "A-retrieval", "A-tool-loop"] as const);
export const EvalSystemSchema = z.enum(["A", "A1", "B1", "deterministic", ...experimentalEvalSystems]);
export type EvalSystem = z.infer<typeof EvalSystemSchema>;
const seeds = z.array(z.number().int().nonnegative().safe()).min(1).max(20).refine(items => new Set(items).size === items.length, "Duplicate seeds");
export const EvalProtocolSchema = z.object({
  version: z.literal(1), corpus: z.enum(["public-nextjs", "controlled-fixtures"]), frozenAt: z.iso.datetime(), selection: z.string().min(1),
  repositories: z.array(z.object({ repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), sha: z.string().regex(/^[a-f0-9]{40}$/), license: z.enum(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"]), split: z.enum(["dev", "test"]) }).strict()).min(1).max(100)
    .refine(items => new Set(items.map(item => item.repository.toLowerCase())).size === items.length, "Repository splits must be disjoint and unique"),
  model: LlmModelConfigSchema, operators: z.array(OperatorSchema).min(1).refine(items => new Set(items).size === items.length, "Duplicate operators"),
  systems: z.array(EvalSystemSchema).min(1).refine(items => new Set(items).size === items.length, "Duplicate systems"),
  seeds: z.object({ dev: seeds, test: seeds }).strict(),
  maxCasesPerRepository: z.number().int().positive().max(1000), targetTestCases: z.number().int().positive(),
}).strict();
export type EvalProtocol = z.infer<typeof EvalProtocolSchema>;
const FrozenProtocolSchema = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), protocol: EvalProtocolSchema }).strict();
export type FrozenProtocol = z.infer<typeof FrozenProtocolSchema>;
function digest(protocol: EvalProtocol): string { return createHash("sha256").update(JSON.stringify(protocol)).digest("hex"); }

/** Exclusive creation: selecting another protocol never silently relabels past results. */
export async function freezeProtocol(path: string, input: unknown): Promise<FrozenProtocol> {
  const protocol = EvalProtocolSchema.parse(input);
  const frozen = { digest: digest(protocol), protocol };
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(frozen, null, 2)); await file.sync(); }
  finally { await file.close(); }
  return frozen;
}
export async function readFrozenProtocol(path: string): Promise<FrozenProtocol> {
  const frozen = FrozenProtocolSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (digest(frozen.protocol) !== frozen.digest) throw new Error("Frozen evaluation protocol digest changed");
  return frozen;
}
export function systemPolicy(input: EvalSystem) {
  const system = EvalSystemSchema.parse(input);
  const baseline = system === "B1" || system === "B2", iterative = system === "A" || experimentalEvalSystems.some(item => item === system);
  return { attempts: iterative ? 3 : 1, usesLlm: system !== "deterministic", enrichedContext: !baseline, verificationFeedback: iterative, deterministicFirst: !baseline };
}
