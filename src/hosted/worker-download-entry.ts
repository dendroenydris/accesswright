import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { assertSecretlessWorker, workerLayout } from "../runner/worker-boundary.js";
import { appendRunRecord } from "../tracer/run-record.js";
import { HostedAgentClient } from "./agent-client.js";
import { materializeHostedInput } from "./input-bundle.js";
import { runHostedWorker } from "./worker.js";

/** Generic image: private input is fetched at run time and erased before candidate transfer. */
export async function runHostedDownloadedWorkerEntry(): Promise<void> {
  await assertSecretlessWorker();
  const configuration = z.object({
    ACCESSWRIGHT_RUN_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), ACCESSWRIGHT_RUN_TOKEN: z.string().regex(/^[a-f0-9]{64}$/),
    ACCESSWRIGHT_AGENT_ORIGIN: z.string().url(), ACCESSWRIGHT_PROVIDER_VERIFICATION: z.enum(["fake-provider", "provider-api"]),
  }).parse(process.env);
  const client = new HostedAgentClient({ origin: configuration.ACCESSWRIGHT_AGENT_ORIGIN, runId: configuration.ACCESSWRIGHT_RUN_ID, token: configuration.ACCESSWRIGHT_RUN_TOKEN });
  const directory = join(workerLayout.temporary, "input-" + configuration.ACCESSWRIGHT_RUN_ID);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const record = (step: string, status: "ok" | "error") => appendRunRecord(join(directory, "run.jsonl"), { timestamp: new Date().toISOString(), step, status });
  let owned = false;
  try {
    await record("hosted-input-download", "ok");
    await materializeHostedInput(await client.downloadInput(), workerLayout.downloadedInput); owned = true;
    await record("hosted-input-materialized", "ok");
    await runHostedWorker({ client, repoPath: workerLayout.downloadedInput, providerVerification: configuration.ACCESSWRIGHT_PROVIDER_VERIFICATION,
      submitCandidate: async candidate => {
        await rm(workerLayout.downloadedInput, { recursive: true, force: true }); owned = false;
        await record("hosted-input-cleared", "ok");
        await client.submitCandidate(candidate);
      } });
  } catch (error) { await record("hosted-downloaded-worker", "error"); throw error; }
  finally { if (owned) { await rm(workerLayout.downloadedInput, { recursive: true, force: true }); await record("hosted-input-cleared", "ok"); } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runHostedDownloadedWorkerEntry(); }
  catch { console.error("Hosted downloaded worker failed; inspect run metadata"); process.exitCode = 1; }
}
