import { z } from "zod";
import { HostedAgentClient } from "./agent-client.js";
import { createGoogleMetadataIdentityToken } from "./google-access-token.js";

/** Both worker entry points use the same operator-only origin, classification and workload identity. */
export function configureHostedWorker(environment: NodeJS.ProcessEnv) {
  const config = z.object({
    ACCESSWRIGHT_RUN_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), ACCESSWRIGHT_RUN_TOKEN: z.string().regex(/^[a-f0-9]{64}$/),
    ACCESSWRIGHT_AGENT_ORIGIN: z.string().url(), ACCESSWRIGHT_PROVIDER_VERIFICATION: z.enum(["fake-provider", "provider-api"]),
    ACCESSWRIGHT_WORKER_SERVICE_ACCOUNT_EMAIL: z.string().min(1).optional(),
  }).parse(environment);
  if (environment.CLOUD_RUN_JOB && !config.ACCESSWRIGHT_WORKER_SERVICE_ACCOUNT_EMAIL) throw new Error("Cloud Run worker identity configuration is required");
  return { runId: config.ACCESSWRIGHT_RUN_ID, providerVerification: config.ACCESSWRIGHT_PROVIDER_VERIFICATION,
    client: new HostedAgentClient({ origin: config.ACCESSWRIGHT_AGENT_ORIGIN, runId: config.ACCESSWRIGHT_RUN_ID, token: config.ACCESSWRIGHT_RUN_TOKEN,
      ...(config.ACCESSWRIGHT_WORKER_SERVICE_ACCOUNT_EMAIL ? { getIdentityToken: createGoogleMetadataIdentityToken({
        audience: new URL(config.ACCESSWRIGHT_AGENT_ORIGIN).origin, serviceAccountEmail: config.ACCESSWRIGHT_WORKER_SERVICE_ACCOUNT_EMAIL,
      }) } : {}) }) };
}
