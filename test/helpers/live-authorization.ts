import { isAbsolute } from "node:path";
import { z } from "zod";

const schema = z.object({ model: z.literal("gpt-6-luna"), reasoningEffort: z.literal("high"), authenticatedModel: z.literal(true),
  verifiedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), maxInputTokens: z.number().int().positive(),
  pricing: z.object({ inputUsdPerMillion: z.number().finite().positive(), outputUsdPerMillion: z.number().finite().positive() }).strict(),
  costBasis: z.literal("conservative-token-price-upper-bound"), ledgerPath: z.string().refine(isAbsolute), maxRunCostUsd: z.number().positive().max(1),
  pricingSource: z.literal("https://developers.openai.com/api/docs/models/gpt-6-luna"),
}).strict();

export function parseLiveAuthorization(input: unknown, now = Date.now()) {
  const authorization = schema.parse(input);
  if (Date.parse(authorization.expiresAt) <= now) throw new Error("Live authorization has expired; recheck pricing and the cumulative ledger");
  if (Date.parse(authorization.verifiedAt) > now || Date.parse(authorization.expiresAt) - Date.parse(authorization.verifiedAt) > 24 * 60 * 60 * 1000) throw new Error("Pricing authorization must be current and no longer than one day");
  return authorization;
}
