import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { defaults } from "../config.js";
import { assertSecretlessWorker, validateSecretlessWorkerEnvironment, workerLayout } from "../runner/worker-boundary.js";
import { toolingRoot } from "../runner/install-plan.js";
import { copyTargetSnapshot } from "./source-boundary.js";
import type { RepairExecOptions, RepairExecResult, RepairTransport } from "./repair-transport.js";

/** Untrusted candidate worker only; the trusted service independently replays its output. */
export class EphemeralRepairTransport implements RepairTransport {
  readonly kind = "ephemeral" as const;
  readonly application = "isolated-worker";
  readonly baseUrl = "http://127.0.0.1:3000" as const;
  private readonly evidenceDir: string;
  private claimed = false;
  private created = false;

  constructor(evidenceDir: string) {
    this.evidenceDir = z.string().regex(/^\/tmp\/accesswright\/repair-run-[A-Za-z0-9]+\/evidence$/).parse(evidenceDir);
  }

  async create(source: string): Promise<void> {
    await assertSecretlessWorker();
    if (this.claimed) throw new Error("Worker transport is already occupied");
    const lock = await open(join(workerLayout.temporary, "worker.lock"), "wx", 0o600);
    await lock.close();
    this.claimed = true;
    try {
    if ((await readdir("/workspace")).length > 0) throw new Error("Worker workspace is already occupied");
    try { await access(toolingRoot); throw new Error("Worker tooling path is already occupied"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await mkdir(this.evidenceDir, { recursive: true });
    this.created = true;
    await copyTargetSnapshot(source, "/workspace");
    } catch (error) {
      if (!this.created) { this.claimed = false; await rm(join(workerLayout.temporary, "worker.lock")); }
      throw error;
    }
  }

  async exec(role: "application" | "browser", command: readonly string[], options: RepairExecOptions = {}): Promise<RepairExecResult> {
    if (!this.created) throw new Error("Worker transport has not been created");
    if (options.user !== undefined && options.user !== "pwuser") throw new Error("Worker cannot change its process user");
    const executable = command[0];
    if (!executable) throw new Error("Missing worker executable");
    const environment: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/home/pwuser",
      ACCESSWRIGHT_ISOLATED_WORKER: "1", CI: "1", NEXT_TELEMETRY_DISABLED: "1", ...options.environment };
    for (const name of ["CLOUD_RUN_JOB", "CLOUD_RUN_EXECUTION", "CLOUD_RUN_TASK_INDEX", "CLOUD_RUN_TASK_ATTEMPT", "CLOUD_RUN_TASK_COUNT"]) {
      const value = process.env[name];
      if (value !== undefined) environment[name] = value;
    }
    if (role === "browser") {
      environment.ACCESSWRIGHT_EVIDENCE_ROOT = this.evidenceDir;
      if (process.env.PLAYWRIGHT_BROWSERS_PATH) environment.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
    }
    validateSecretlessWorkerEnvironment(environment);
    if (environment.ACCESSWRIGHT_RUN_TOKEN !== undefined) throw new Error("Repository subprocess cannot inherit a run token");
    const result = await execa(executable, command.slice(1), { cwd: "/workspace", env: environment, extendEnv: false, reject: false,
      timeout: options.timeoutMs ?? defaults.productionCheckTimeoutMs, forceKillAfterDelay: defaults.processKillGraceMs, maxBuffer: defaults.maximumDiagnosticBytes });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? (result.timedOut ? 124 : 1), timedOut: result.timedOut };
  }

  async copyToApplication(source: string, destination: string): Promise<void> {
    if (!this.created) throw new Error("Worker transport has not been created");
    const target = resolve(destination);
    if (target !== "/workspace" && !target.startsWith("/workspace/")) throw new Error("Worker copy escapes its workspace");
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error("Refusing a symbolic-link transfer");
    if (info.isDirectory()) { await copyTargetSnapshot(source, target); return; }
    if (!info.isFile()) throw new Error("Worker transfer requires a regular file");
    let parent = "/workspace";
    for (const part of target.slice("/workspace/".length).split("/").slice(0, -1)) {
      parent = join(parent, part);
      const directory = await lstat(parent);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Untrusted worker destination directory");
    }
    const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
    try { await output.writeFile(await readFile(source)); await output.sync(); }
    finally { await output.close(); }
  }

  ownWorkspace(): Promise<void> { return Promise.resolve(); } // Files are already created by the unprivileged worker user.
  finishInstall(): Promise<void> { return Promise.resolve(); }
  syncEvidence(names: readonly string[]): Promise<void> {
    for (const name of names) z.string().regex(/^[A-Za-z0-9_-]+\.png$/).max(200).parse(name);
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (!this.claimed) return;
    try {
      if (this.created) {
        const stopped = await this.exec("application", ["node", "/accesswright/dist/src/runner/target-entry.js", '{"action":"stop"}'], { environment: { ACCESSWRIGHT_ISOLATED_TARGET: "1" } });
        if (stopped.exitCode !== 0) throw new Error("Worker server cleanup failed");
      }
    } finally {
      for (const entry of await readdir("/workspace")) await rm(join("/workspace", entry), { recursive: true, force: true });
      await rm(toolingRoot, { recursive: true, force: true });
      for (const name of ["server.json", "server.log", "build.log", "typecheck.log", "lint.log", "tests.log"]) await rm(join(workerLayout.temporary, name), { force: true });
      this.created = false;
      this.claimed = false;
      await rm(join(workerLayout.temporary, "worker.lock"));
    }
  }
}
