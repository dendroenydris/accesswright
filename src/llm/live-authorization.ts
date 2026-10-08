import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

const schema = z.object({ model: z.literal("gpt-6-luna"), reasoningEffort: z.literal("high"), authenticatedModel: z.literal(true),
  verifiedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), maxInputTokens: z.number().int().positive(),
  pricing: z.object({ inputUsdPerMillion: z.number().finite().positive(), outputUsdPerMillion: z.number().finite().positive() }).strict(),
  costBasis: z.literal("conservative-token-price-upper-bound"), ledgerPath: z.string().refine(isAbsolute), maxRunCostUsd: z.number().positive().max(1),
  pricingSource: z.literal("https://developers.openai.com/api/docs/models/gpt-6-luna"),
}).strict();

/** Dated operator metadata, not a credential store. The product provider abstraction remains model-configurable. */
export function parseLiveAuthorization(input: unknown, now = Date.now()) {
  const authorization = schema.parse(input);
  if (Date.parse(authorization.expiresAt) <= now) throw new Error("Live authorization has expired; recheck pricing and the cumulative ledger");
  if (Date.parse(authorization.verifiedAt) > now || Date.parse(authorization.expiresAt) - Date.parse(authorization.verifiedAt) > 24 * 60 * 60 * 1000) throw new Error("Pricing authorization must be current and no longer than one day");
  return authorization;
}

export async function readLiveAuthorization(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 32768) throw new Error("Authorization metadata must be a bounded regular file");
    return parseLiveAuthorization(JSON.parse(await file.readFile("utf8")));
  } finally { await file.close(); }
}

/** Read-only authentication at a fixed official origin; no redirects, retries, model calls, or response diagnostics. */
export async function authenticateOpenAIModel(model: string, environment: Readonly<Record<string,string|undefined>> = process.env, fetcher: typeof fetch = fetch): Promise<{model:string;httpStatus:200}> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(model)) throw new Error("Invalid model identity");
  const key = environment.OPENAI_API_KEY;
  if (!key?.trim() || /[\r\n]/.test(key)) throw new Error("OPENAI_API_KEY is missing or malformed");
  const response = await fetcher(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, { method:"GET", redirect:"error",signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${key}`} });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Model authentication failed with HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Model authentication returned an empty response");
  const chunks: Uint8Array[] = []; let length=0;
  try {
    while (true) {
      const chunk=await reader.read(); if(chunk.done)break;
      length+=chunk.value.byteLength;
      if(length>65536){await reader.cancel();throw new Error("Model authentication response exceeds its bound");}
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const metadata = z.object({id:z.string()}).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if(metadata.id!==model)throw new Error("Authenticated model identity does not match the frozen protocol");
  return {model,httpStatus:200};
}
