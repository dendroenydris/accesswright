import { constants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import { z } from "zod";

export const workerLayout = Object.freeze({ runtime: "/accesswright", input: "/input", downloadedInput: "/input/source", temporary: "/tmp/accesswright", marker: "/accesswright/.isolated-worker" });
const markerText = "accesswright-secretless-worker-v1\n";
const allowedEnvironment = new Set([
  "PATH", "HOME", "HOSTNAME", "LANG", "LC_ALL", "PLAYWRIGHT_BROWSERS_PATH", "CI", "NEXT_TELEMETRY_DISABLED", "NODE_ENV",
  "ACCESSWRIGHT_ISOLATED_WORKER", "ACCESSWRIGHT_ISOLATED_TARGET", "ACCESSWRIGHT_EVIDENCE_ROOT",
  "ACCESSWRIGHT_RUN_ID", "ACCESSWRIGHT_RUN_TOKEN", "ACCESSWRIGHT_AGENT_ORIGIN", "ACCESSWRIGHT_PROVIDER_VERIFICATION",
  "ACCESSWRIGHT_REPOSITORY", "ACCESSWRIGHT_INSTALLATION_ID", "ACCESSWRIGHT_PR_NUMBER",
  "CLOUD_RUN_JOB", "CLOUD_RUN_EXECUTION", "CLOUD_RUN_TASK_INDEX", "CLOUD_RUN_TASK_ATTEMPT", "CLOUD_RUN_TASK_COUNT",
]);

/** An allowlist also rejects custom credential variables with innocuous names. */
export function validateSecretlessWorkerEnvironment(environment: NodeJS.ProcessEnv): void {
  if (Object.entries(environment).some(([name, value]) => value !== undefined && !allowedEnvironment.has(name))) throw new Error("Secretless worker environment is not allowlisted");
  if (environment.ACCESSWRIGHT_RUN_TOKEN !== undefined && !/^[a-f0-9]{64}$/.test(environment.ACCESSWRIGHT_RUN_TOKEN)) throw new Error("Invalid scoped worker token");
  if (Object.keys(environment).some(name => name.startsWith("CLOUD_RUN_") && environment[name] !== undefined)) {
    const valid = z.object({ CLOUD_RUN_JOB: z.string().min(1), CLOUD_RUN_EXECUTION: z.string().min(1), CLOUD_RUN_TASK_INDEX: z.literal("0"),
      CLOUD_RUN_TASK_COUNT: z.literal("1"), CLOUD_RUN_TASK_ATTEMPT: z.literal("0") }).safeParse(environment);
    if (!valid.success) throw new Error("Worker requires one initial Cloud Run Job task");
  }
}

/** Docker, or a trusted Cloud Run Job image marker; an environment flag alone is insufficient. */
export async function assertContainerRuntime(): Promise<void> {
  if (process.platform !== "linux") throw new Error("Repository execution requires an isolated Linux container");
  try { await access("/.dockerenv"); return; } catch { /* Cloud Run does not promise Docker's marker. */ }
  if (process.env.ACCESSWRIGHT_ISOLATED_WORKER !== "1" || !process.env.CLOUD_RUN_JOB) throw new Error("No trusted container runtime boundary");
  validateSecretlessWorkerEnvironment(process.env);
  const marker = await lstat(workerLayout.marker);
  if (!marker.isFile() || marker.isSymbolicLink() || marker.uid !== 0 || (marker.mode & 0o022) !== 0 || marker.size !== Buffer.byteLength(markerText) ||
    await readFile(workerLayout.marker, "utf8") !== markerText) throw new Error("Untrusted worker image marker");
}

export async function assertSecretlessWorker(): Promise<void> {
  await assertContainerRuntime();
  validateSecretlessWorkerEnvironment(process.env);
  if (process.env.ACCESSWRIGHT_ISOLATED_WORKER !== "1" || !process.getuid || process.getuid() === 0) throw new Error("Secretless worker requires an explicit unprivileged container process");
  const runtime = await lstat(workerLayout.runtime);
  if (!runtime.isDirectory() || runtime.isSymbolicLink() || runtime.uid !== 0 || (runtime.mode & 0o022) !== 0) throw new Error("Untrusted worker runtime directory");
  try { await access(workerLayout.runtime, constants.W_OK); }
  catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EROFS")) return;
    throw error;
  }
  throw new Error("Worker runtime must be read-only to repository code");
}
