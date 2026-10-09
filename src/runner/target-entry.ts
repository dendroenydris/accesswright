import { spawn } from "node:child_process";
import { access, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import { z } from "zod";
import { defaults } from "../config.js";
import { removePlatformMetadata } from "../sandbox/platform-metadata.js";
import { PackageManifestSchema, checkFailureIds, productionCheckPlan } from "./production-checks.js";
import type { ProductionCheckResult } from "./production-checks.js";
import { TargetCommandSchema, targetProcessEnvironment } from "./session-protocol.js";
import { hasStaticExport } from "./static-export-server.js";
import { targetServerCommand } from "./server-plan.js";

await access("/.dockerenv");
if (process.platform !== "linux" || process.env.ACCESSWRIGHT_ISOLATED_TARGET !== "1") throw new Error("Target execution requires an explicitly isolated Docker process");
const command = TargetCommandSchema.parse(JSON.parse(process.argv[2] ?? "null"));
const workspace = "/workspace";
await removePlatformMetadata(workspace);
const pidFile = "/tmp/accesswright/server.json";

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
async function stopServer(): Promise<void> {
  if (!await exists(pidFile)) return;
  const { pid } = z.object({ pid: z.number().int().min(2) }).parse(JSON.parse(await readFile(pidFile, "utf8")));
  try {
    process.kill(-pid, "SIGTERM");
    await delay(350);
    try { process.kill(-pid, 0); process.kill(-pid, "SIGKILL"); } catch { /* The owned process group already exited. */ }
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
  await rm(pidFile, { force: true });
}

if (command.action === "inspect") {
  const next = z.object({ version: z.string() }).parse(JSON.parse(await readFile(join(workspace, "node_modules/next/package.json"), "utf8")));
  const privateFilesPresent: string[] = [];
  for (const path of [".env", ".env.local", ".npmrc", ".netrc"]) if (await exists(join(workspace, path))) privateFilesPresent.push(path);
  console.log(JSON.stringify({ nextVersion: next.version, hasTypeScript: await exists(join(workspace, "node_modules/.bin/tsc")), processEnvironmentNames: Object.keys(targetProcessEnvironment(process.env)).sort(), privateFilesPresent }));
} else if (command.action === "stop") {
  await stopServer();
  console.log(JSON.stringify({ stopped: true }));
} else if (command.action === "reset-source") {
  await stopServer();
  for (const entry of await readdir(workspace)) {
    if (entry !== "node_modules") await rm(join(workspace, entry), { recursive: true, force: true });
  }
  console.log(JSON.stringify({ reset: true }));
} else if (command.action === "start") {
  await stopServer();
  const manifest = PackageManifestSchema.parse(JSON.parse(await readFile(join(workspace, "package.json"), "utf8")));
  const staticMode = command.mode === "production" && await hasStaticExport(workspace);
  const argv = staticMode
    ? ["node", "/accesswright/dist/src/runner/static-export-server.js", String(defaults.targetPort)]
    : targetServerCommand(command.mode, manifest.scripts, defaults.targetPort);
  const executable = argv[0];
  if (executable === undefined) throw new Error("No target executable");
  const log = await open("/tmp/accesswright/server.log", "w");
  try {
    const child = spawn(executable, argv.slice(1), { cwd: workspace, detached: true, stdio: ["ignore", log.fd, log.fd],
      env: { ...targetProcessEnvironment(process.env), ...(staticMode ? { ACCESSWRIGHT_ISOLATED_TARGET: "1" } : {}), NODE_ENV: command.mode === "dev" ? "development" : "production" } });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    if (child.pid === undefined) throw new Error("Development process did not start");
    await writeFile(pidFile, JSON.stringify({ pid: child.pid }), "utf8");
    child.unref();
    console.log(JSON.stringify({ started: true, mode: command.mode, pid: child.pid }));
  } finally { await log.close(); }
} else {
  const manifest: unknown = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));
  const plan = productionCheckPlan(manifest, await exists(join(workspace, "node_modules/.bin/tsc")));
  const checks: ProductionCheckResult[] = [];
  for (const step of plan.filter(step => command.checks.includes(step.check))) {
    if (!step.available) {
      checks.push({ ...step, status: "unavailable", durationMs: 0, exitCode: null, failureIds: [] });
      continue;
    }
    const executable = step.argv[0];
    if (!executable) throw new Error("Missing production check executable");
    const started = Date.now();
    const result = await execa(executable, step.argv.slice(1), { cwd: workspace, env: targetProcessEnvironment(process.env), extendEnv: false,
      reject: false, timeout: defaults.productionCheckTimeoutMs, maxBuffer: defaults.maximumDiagnosticBytes });
    const exitCode = result.exitCode ?? (result.timedOut ? 124 : 1);
    checks.push({ ...step, status: exitCode === 0 ? "passed" : "failed", durationMs: Date.now() - started, exitCode,
      failureIds: checkFailureIds(step.check, exitCode, `${result.stdout}\n${result.stderr}`),
      ...(command.privateDiagnostics && exitCode !== 0 ? { diagnostic: `${result.stdout}\n${result.stderr}`.slice(-12000) } : {}) });
    await writeFile(`/tmp/accesswright/${step.check}.log`, `${result.stdout}\n${result.stderr}`, "utf8");
  }
  console.log(JSON.stringify({ checks }));
}
