import { LlmModelConfigSchema } from "../types/schemas.js";
import type { LlmModelConfig } from "../types/schemas.js";

/** Repository configuration may select a model, but not redirect host credentials without operator trust. */
export function resolveExecutionModel(input: unknown, trustProviderConfig = false): LlmModelConfig {
  const model = LlmModelConfigSchema.parse(input);
  if (!trustProviderConfig && model.baseURL !== undefined) {
    throw new Error("A custom provider endpoint requires explicitly trusted operator configuration");
  }
  if (!trustProviderConfig && model.apiKeyEnv !== undefined) {
    throw new Error("A custom credential variable requires explicitly trusted operator configuration");
  }
  if (model.baseURL !== undefined) {
    const endpoint = new URL(model.baseURL);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (endpoint.username || endpoint.password || (endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:"))) {
      throw new Error("Provider endpoints must use HTTPS, except explicitly trusted loopback providers");
    }
  }
  return model;
}
