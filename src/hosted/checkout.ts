import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { fetchPinnedRepository } from "../eval/repository.js";
import { appendRunRecord } from "../tracer/run-record.js";
import type { HostedVerificationCheckout } from "./trusted-verifier.js";

/** Trusted caller supplies the original pinned revision and repository-scoped installation token. */
export async function prepareHostedCheckout(options: {
  runId: string;
  repository: string;
  verifiedBaseSha: string;
  installationToken?: string;
  tempRoot: string;
  runtimeRoot: string;
  evidenceRoot: string;
}): Promise<HostedVerificationCheckout> {
  const runId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).parse(options.runId);
  const baseSha = z.string().regex(/^[a-f0-9]{40}$/).parse(options.verifiedBaseSha);
  const evidence = join(options.evidenceRoot, runId, "run.jsonl");
  await mkdir(join(options.evidenceRoot, runId), { recursive: true, mode: 0o700 });
  await mkdir(options.tempRoot, { recursive: true, mode: 0o700 });
  const ownedRoot = await mkdtemp(join(options.tempRoot, "hosted-checkout-"));
  const record = (step: string, status: "ok" | "error") => appendRunRecord(evidence, {
    timestamp: new Date().toISOString(), step, status, metadata: { baseSha },
  });
  const release = async () => {
    try { await rm(ownedRoot, { recursive: true, force: true }); }
    catch { await record("hosted-checkout-erasure", "error"); throw new Error("Trusted checkout erasure is unconfirmed"); }
    await record("hosted-checkout-erasure", "ok");
  };
  try {
    const repoPath = await fetchPinnedRepository(ownedRoot, options.repository, baseSha, options.installationToken);
    await record("hosted-checkout-fetch", "ok");
    return { repoPath, verifiedBaseSha: baseSha, tempRoot: options.tempRoot, runtimeRoot: options.runtimeRoot, release };
  } catch {
    try { await record("hosted-checkout-fetch", "error"); }
    finally { await release(); }
    // Git failures can carry HTTP credentials in process details; propagate only this redacted failure.
    throw new Error("Trusted checkout preparation failed");
  }
}
