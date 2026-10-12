#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaults } from "../config.js";
import { isMainModule } from "../entrypoint.js";
import { appendRunRecord } from "../tracer/run-record.js";
import { FirestoreSpendLedger } from "./firestore-spend-ledger.js";
import { createGoogleMetadataAccessToken } from "./google-access-token.js";
import { HostedServiceConfigSchema } from "./service-entry.js";

/** Operator-only read of the original allowance scopes; never provisions a policy or changes usage. */
export async function runHostedSpendCli(args: readonly string[], environment: NodeJS.ProcessEnv = process.env, options: { fetcher?: typeof fetch } = {}) {
  if (args.length !== 6 || args[0] !== "--reservation-id" || args[2] !== "--installation-id" || args[4] !== "--month" ||
    !/^[1-9][0-9]*$/.test(args[3]) || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(args[5])) throw new Error("Expected --reservation-id <UUID> --installation-id <positive ID> --month <original YYYY-MM>");
  const id = z.string().uuid().parse(args[1]), installationId = z.coerce.number().int().positive().safe().parse(args[3]);
  const raw = environment.ACCESSWRIGHT_HOSTED_CONFIG;
  if (!raw || Buffer.byteLength(raw) > defaults.configMaxBytes) throw new Error("Bounded operator service configuration is required");
  const config = HostedServiceConfigSchema.parse(JSON.parse(raw) as unknown);
  if (config.role !== "agent" || new Set(Object.values(config.collections)).size !== Object.keys(config.collections).length) throw new Error("Usage observation requires the agent's distinct metadata configuration");
  const directory = join(config.workRoot, "evidence", "usage", id), record = join(directory, "run.jsonl");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendRunRecord(record, { timestamp: new Date().toISOString(), step: "hosted-usage-read-start", status: "ok" });
  try {
    const ledger = await FirestoreSpendLedger.open({ projectId: config.projectId, collectionId: config.collections.spending,
      getAccessToken: createGoogleMetadataAccessToken(options.fetcher), ...options,
      budgetId: defaults.hostedGlobalBudgetPrefix + args[5], installationBudgetId: defaults.hostedInstallationBudgetPrefix + installationId + "-" + args[5] });
    const result = await ledger.observeReservation(id);
    await appendRunRecord(record, { timestamp: new Date().toISOString(), step: "hosted-usage-read-result",
      status: result.state === "settled" ? "ok" : "skipped", metadata: { outcome: result.state } });
    return result;
  } catch (error) {
    await appendRunRecord(record, { timestamp: new Date().toISOString(), step: "hosted-usage-read-result", status: "error" }); throw error;
  }
}

if (await isMainModule(import.meta.url)) {
  runHostedSpendCli(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.state === "settled" ? 0 : 1;
  }).catch(() => {
    process.stderr.write("Usage observation is unconfirmed; check original scopes, operator configuration and metadata access\n"); process.exitCode = 2;
  });
}
