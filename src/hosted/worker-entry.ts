import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSecretlessWorker } from "../runner/worker-boundary.js";
import { configureHostedWorker } from "./worker-configuration.js";
import { runHostedWorker } from "./worker.js";

/** Image-configured origin and classification; no provider keys, command arguments or publishing authority. */
export async function runHostedWorkerEntry(): Promise<void> {
  await assertSecretlessWorker();
  const { client, providerVerification } = configureHostedWorker(process.env);
  await runHostedWorker({ client, providerVerification,
    submitCandidate: candidate => client.submitCandidate(candidate) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runHostedWorkerEntry(); }
  catch { console.error("Hosted worker failed; inspect run metadata"); process.exitCode = 1; }
}
