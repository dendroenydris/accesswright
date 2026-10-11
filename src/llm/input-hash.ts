import { createHash } from "node:crypto";
import type { LlmCallRequest } from "./types.js";

export function hashLlmInput(request: Pick<LlmCallRequest, "prompt" | "system" | "images">): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1, prompt: request.prompt, system: request.system ?? null,
    images: (request.images ?? []).map(image => ({ mediaType: image.mediaType,
      sha256: createHash("sha256").update(image.data).digest("hex") })),
  })).digest("hex");
}
