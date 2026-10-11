import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { assertSecretlessWorker } from "../runner/worker-boundary.js";
import { HostedAgentClient } from "./agent-client.js";
import { runHostedWorker } from "./worker.js";

/** Image-configured origin and classification; no provider keys, command arguments or publishing authority. */
export async function runHostedWorkerEntry(): Promise<void> {
  await assertSecretlessWorker();
  const configuration = z.object({
    ACCESSWRIGHT_RUN_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    ACCESSWRIGHT_RUN_TOKEN: z.string().regex(/^[a-f0-9]{64}$/),
    ACCESSWRIGHT_AGENT_ORIGIN: z.string().url(),
    ACCESSWRIGHT_PROVIDER_VERIFICATION: z.enum(["fake-provider", "provider-api"]),
  }).parse(process.env);
  const client = new HostedAgentClient({ origin: configuration.ACCESSWRIGHT_AGENT_ORIGIN,
    runId: configuration.ACCESSWRIGHT_RUN_ID, token: configuration.ACCESSWRIGHT_RUN_TOKEN });
  await runHostedWorker({ client, providerVerification: configuration.ACCESSWRIGHT_PROVIDER_VERIFICATION,
    submitCandidate: candidate => client.submitCandidate(candidate) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runHostedWorkerEntry(); }
  catch { console.error("Hosted worker failed; inspect run metadata"); process.exitCode = 1; }
}
