import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaults, loadConfig } from "../config.js";
import { AccesswrightConfigSchema, PatchSchema } from "../types/schemas.js";
import type { AccesswrightConfig, FixTask, Patch } from "../types/schemas.js";
import { copyTargetSnapshot, resolveSafeSource } from "../sandbox/source-boundary.js";
import { applyTransferredPatch } from "../sandbox/source-transfer.js";
import { IsolatedDockerSession } from "../sandbox/session.js";
import { dockerCopy, dockerExec, dockerExecResult } from "../sandbox/docker.js";
import { discoverFileRoutes, materializeRoutes } from "../routes/discovery.js";
import { observationsToState } from "../scanner/observations.js";
import type { BrowserObservation } from "../scanner/observations.js";
import { violationKey } from "../scanner/browser-facts.js";
import { verifyPerPatch } from "../verifier/per-patch.js";
import { unresolvedProductionTargets } from "../verifier/production-targets.js";
import type { PerPatchVerificationResult } from "../verifier/per-patch.js";
import { verifyFinal as verifyFixSet } from "../verifier/final.js";
import type { FinalCheckSnapshot, FinalVerificationResult } from "../verifier/final.js";
import { appendRunRecord } from "../tracer/run-record.js";
import { detectPackageManager } from "./detect.js";
import { PatchJournal, listSnapshotFiles } from "./patch-journal.js";
import { instrumentConfigSource } from "./config-merge.js";
import { clearPrivateEvidence, recordPrivateScan } from "./evidence-retention.js";
import { PackageManifestSchema, snapshotFromChecks } from "./production-checks.js";
import type { ProductionCheck, ProductionCheckResult } from "./production-checks.js";
import { BrowserCommandSchema, BrowserScanOutputSchema, CheckOutputSchema, CrawlOutputSchema, TargetCommandSchema, TargetInspectionSchema, sourceRoutesForChanges } from "./session-protocol.js";

const targetEnvironment = { ACCESSWRIGHT_ISOLATED_TARGET: "1", HOME: "/home/pwuser", NEXT_TELEMETRY_DISABLED: "1", CI: "1" };
const checkNames: ProductionCheck[] = ["build", "typecheck", "lint", "tests"];
const baseUrl = "http://accesswright-app:3000" as const;
const configNames = ["next.config.mjs", "next.config.js", "next.config.ts", "next.config.cjs", "next.config.mts", "next.config.cts"];

export interface RepairSessionOptions {
  repoPath: string;
  tempRoot: string;
  runtimeRoot: string;
  config?: z.input<typeof AccesswrightConfigSchema>;
  /** Opt-in local diagnostics for owned fixtures; never enabled by hosted or normal CLI defaults. */
  privateDiagnostics?: boolean;
  retainEvidence?: boolean;
}

export class UnsupportedRepositoryError extends Error {
  readonly evidenceDir: string;
  constructor(message: string, evidenceDir: string) { super(message); this.evidenceDir = evidenceDir; this.name = "UnsupportedRepositoryError"; }
}

export class DockerRepairSession {
  readonly sourceRoot: string;
  readonly evidenceDir: string;
  readonly config: AccesswrightConfig;
  readonly journal: PatchJournal;
  readonly sandbox: IsolatedDockerSession;
  readonly repoPath: string;
  readonly runRoot: string;
  routes: string[] = [];
  observations: BrowserObservation[] = [];
  baselineObservations: BrowserObservation[] = [];
  productionBaseline: BrowserObservation[] = [];
  finalObservations: BrowserObservation[] = [];
  baselineChecks: ProductionCheckResult[] = [];
  finalChecks: ProductionCheckResult[] = [];
  inspection: z.infer<typeof TargetInspectionSchema> = { nextVersion: "", hasTypeScript: false, processEnvironmentNames: [], privateFilesPresent: [] };
  readonly tasks = new Map<string, FixTask>();
  private finalSequence = 0;
  private currentFixSet = "";
  private finalResult: FinalVerificationResult | null = null;
  private readonly privateDiagnostics: boolean;
  private readonly retainEvidence: boolean;

  private constructor(options: RepairSessionOptions, config: AccesswrightConfig, runRoot: string, journal: PatchJournal, sandbox: IsolatedDockerSession) {
    this.repoPath = options.repoPath; this.config = config; this.runRoot = runRoot;
    this.sourceRoot = join(runRoot, "source"); this.evidenceDir = join(runRoot, "evidence");
    this.journal = journal; this.sandbox = sandbox;
    this.privateDiagnostics = options.privateDiagnostics === true;
    this.retainEvidence = options.retainEvidence === true || this.privateDiagnostics;
  }

  get applicationContainer(): string { return this.sandbox.application; }

  static async prepare(options: RepairSessionOptions): Promise<DockerRepairSession> {
    const config = options.config === undefined ? await loadConfig(options.repoPath) : AccesswrightConfigSchema.parse(options.config);
    await mkdir(options.tempRoot, { recursive: true });
    const runRoot = await mkdtemp(join(options.tempRoot, "repair-run-"));
    const sourceRoot = join(runRoot, "source"), evidenceDir = join(runRoot, "evidence");
    await mkdir(evidenceDir);
    await copyTargetSnapshot(options.repoPath, sourceRoot);
    const files = await listSnapshotFiles(sourceRoot);
    const manager = detectPackageManager(files);
    if (manager !== null && manager !== "npm") throw new UnsupportedRepositoryError(`Persistent runner does not yet support the ${manager} lockfile`, evidenceDir);
    const manifest = PackageManifestSchema.parse(JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8")));
    if (!(manifest.dependencies.next ?? manifest.devDependencies.next)) throw new UnsupportedRepositoryError("The source is not an eligible Next.js repository", evidenceDir);
    const fileRoutes = discoverFileRoutes(files);
    if (fileRoutes.length === 0) throw new UnsupportedRepositoryError("No eligible application routes were discovered", evidenceDir);
    const journal = await PatchJournal.create(sourceRoot);
    const sandbox = new IsolatedDockerSession({ name: `accesswright-${randomUUID().slice(0, 12)}`, image: defaults.dockerImage,
      runtime: join(options.runtimeRoot, "dist"), dependencies: await realpath(join(options.runtimeRoot, "node_modules")),
      packageJson: join(options.runtimeRoot, "package.json"), evidence: evidenceDir, offline: config.offline });
    const session = new DockerRepairSession(options, config, runRoot, journal, sandbox);
    try {
      await access(join(options.runtimeRoot, "dist/src/runner/target-entry.js"));
      await sandbox.create(sourceRoot);
      const installStarted = Date.now();
      const installed = await dockerExecResult(sandbox.application, ["npm", files.includes("package-lock.json") || files.includes("npm-shrinkwrap.json") ? "ci" : "install", "--ignore-scripts", "--no-audit", "--no-fund"],
        { user: "pwuser", environment: targetEnvironment, timeoutMs: defaults.installTimeoutMs });
      await session.recordStep("install", installed.exitCode === 0 ? "ok" : "error", installStarted, { exitCode: installed.exitCode });
      if (installed.exitCode !== 0) throw new UnsupportedRepositoryError(`Dependency installation failed (exit ${installed.exitCode})`, evidenceDir);
      const mapping = await dockerExecResult(sandbox.application, ["npm", "install", "--ignore-scripts", "--no-save", "--package-lock=false", "--no-audit", "--no-fund", "code-inspector-plugin@2.0.9"],
        { user: "pwuser", environment: targetEnvironment, timeoutMs: defaults.installTimeoutMs });
      if (mapping.exitCode !== 0) throw new UnsupportedRepositoryError("Source-mapping dependency installation failed", evidenceDir);
      session.inspection = TargetInspectionSchema.parse(await session.target({ action: "inspect" }));
      if (session.inspection.privateFilesPresent.length > 0) throw new Error("Private target configuration crossed the snapshot boundary");
      await sandbox.finishInstall();
      session.baselineChecks = await session.runProductionChecks(checkNames);
      await writeFile(join(evidenceDir, "baseline-checks.json"), JSON.stringify(session.baselineChecks, null, 2));
      if (session.baselineChecks.find(check => check.check === "build")?.status !== "passed") {
        throw new UnsupportedRepositoryError("The unmodified production baseline does not build", evidenceDir);
      }
      await session.target({ action: "start", mode: "production" });
      const initial = fileRoutes.find(route => !route.dynamic)?.pattern ?? config.routes[0];
      if (!initial) throw new UnsupportedRepositoryError("Dynamic-only applications require an explicit route", evidenceDir);
      await session.ready(initial);
      const crawled = initial === "/" ? CrawlOutputSchema.parse(await session.browser({ action: "crawl", baseUrl })).paths : config.routes;
      session.routes = [...new Set([...materializeRoutes(fileRoutes, crawled).map(route => route.urlPath), ...config.routes])].sort().slice(0, defaults.maxRoutes);
      session.productionBaseline = await session.scan(session.routes, "production-baseline");
      await session.target({ action: "stop" });
      const existingConfigs = configNames.filter(path => files.includes(path));
      if (existingConfigs.length > 1) throw new UnsupportedRepositoryError("Multiple Next configuration files are ambiguous", evidenceDir);
      const configName = existingConfigs[0] ?? "next.config.mjs";
      const originalConfig = existingConfigs[0] ? await readFile(join(sourceRoot, configName), "utf8") : "export default {};\n";
      const esm = /\.(?:mjs|mts|ts)$/.test(configName) || (configName.endsWith(".js") && manifest.type === "module");
      const instrumentation = instrumentConfigSource(originalConfig, configName, esm, session.inspection.nextVersion);
      const instrumentationPath = join(runRoot, `instrumented-${configName}`);
      await writeFile(instrumentationPath, instrumentation);
      await dockerCopy(instrumentationPath, sandbox.application, `/workspace/${configName}`);
      await dockerExec(sandbox.application, ["chown", "pwuser:pwuser", `/workspace/${configName}`]);
      await session.target({ action: "start", mode: "dev" });
      await session.ready(initial);
      session.observations = await session.scan(session.routes, "dev-baseline");
      // Routes with findings are observed twice. Unstable findings remain evidence, not silently accepted fixes.
      const unstableRoutes = session.observations.filter(page => page.violations.length > 0).map(page => page.route);
      if (unstableRoutes.length > 0) {
        const confirmed = await session.scan([...new Set(unstableRoutes)], "dev-baseline-confirm");
        session.updateObservations(confirmed);
      }
      session.baselineObservations = structuredClone(session.observations);
      await session.recordStep("prepare", "ok", installStarted, { routeCount: session.routes.length, baselineViolationCount: observationsToState(session.observations).violations.length });
      return session;
    } catch (error) {
      await session.recordStep("prepare", "error", Date.now(), { errorClass: error instanceof Error ? error.name : "unknown" });
      await session.close();
      throw error;
    }
  }

  private async recordStep(step: string, status: "ok" | "error" | "rejected" | "skipped", started: number, metadata: Record<string, string | number | boolean | null> = {}): Promise<void> {
    await appendRunRecord(join(this.evidenceDir, "run.jsonl"), { timestamp: new Date().toISOString(), step, status, durationMs: Date.now() - started, metadata });
  }

  private async target(input: z.input<typeof TargetCommandSchema>): Promise<unknown> {
    const command = TargetCommandSchema.parse(input);
    const result = await dockerExecResult(this.sandbox.application, ["node", "/accesswright/dist/src/runner/target-entry.js", JSON.stringify(command)],
      { user: "pwuser", environment: targetEnvironment, timeoutMs: defaults.productionCheckTimeoutMs * 4 + defaults.readyTimeoutMs });
    if (result.exitCode !== 0) throw new Error(`Isolated target ${command.action} failed (exit ${result.exitCode}); diagnostic ${createHash("sha256").update(result.stderr).digest("hex").slice(0, 16)}`);
    return JSON.parse(result.stdout) as unknown;
  }

  private async browser(input: z.input<typeof BrowserCommandSchema>): Promise<unknown> {
    const command = BrowserCommandSchema.parse(input);
    const result = await dockerExecResult(this.sandbox.browser, ["node", "/accesswright/dist/src/scanner/browser-session-entry.js", JSON.stringify(command)], { timeoutMs: defaults.productionCheckTimeoutMs * 2 });
    if (result.exitCode !== 0) throw new Error(`Isolated browser ${command.action} failed (exit ${result.exitCode}); diagnostic ${createHash("sha256").update(result.stderr).digest("hex").slice(0, 16)}`);
    return JSON.parse(result.stdout) as unknown;
  }

  private async ready(route: string): Promise<void> { z.object({ ready: z.literal(true) }).parse(await this.browser({ action: "ready", baseUrl, route })); }

  async readSource(path: string): Promise<string> { return readFile(await resolveSafeSource(this.sourceRoot, path), "utf8"); }

  async applyPatch(patch: Patch): Promise<Patch> {
    return applyTransferredPatch(this.sourceRoot, patch, async path => {
      await dockerCopy(join(this.sourceRoot, path), this.sandbox.application, `/workspace/${path}`);
      await dockerExec(this.sandbox.application, ["chown", "pwuser:pwuser", `/workspace/${path}`]);
    });
  }

  async revertPatch(patch: Patch): Promise<void> { await this.applyPatch({ taskId: patch.taskId, changes: patch.changes.map(change => ({ ...change, before: change.after, after: change.before })) }); }

  async scan(routes: readonly string[], generation: string): Promise<BrowserObservation[]> {
    const started = Date.now();
    const output = BrowserScanOutputSchema.parse(await this.browser({ action: "scan", baseUrl, routes: [...routes], generation, mobile: this.config.scan.mobile, dark: this.config.scan.darkScheme, interactions: true }));
    for (const route of routes) {
      if (!output.observations.some(page => page.route === route && page.condition === "desktop-light")) throw new Error("The browser omitted a requested route");
      if (this.config.scan.mobile && !output.observations.some(page => page.route === route && page.condition === "mobile-light")) throw new Error("The browser omitted a requested mobile scan");
    }
    await this.sandbox.syncEvidence(output.observations.flatMap(page => [page.screenshot, ...page.contexts.map(context => context.screenshot)].filter((name): name is string => name !== null)));
    await recordPrivateScan(this.evidenceDir, generation, output.observations, this.retainEvidence);
    await this.recordStep("scan", "ok", started, { routeCount: routes.length, observationCount: output.observations.length, generation });
    return output.observations;
  }

  affectedRoutes(paths: readonly string[]): string[] {
    const map: Record<string, string[]> = {};
    for (const page of this.observations) for (const file of page.sourceFiles) map[file] = [...new Set([...(map[file] ?? []), page.route])];
    return sourceRoutesForChanges(paths, map, this.routes);
  }

  updateObservations(after: readonly BrowserObservation[]): void {
    const routes = new Set(after.map(page => page.route));
    this.observations = [...this.observations.filter(page => !routes.has(page.route)), ...after];
  }

  async record(patch: Patch, task: FixTask, verification: PerPatchVerificationResult): Promise<void> {
    if (patch.taskId !== task.id) throw new Error("Patch and verification task do not agree");
    const fix = await this.journal.record(patch, verification);
    this.tasks.set(task.id, task);
    await this.recordStep("patch", "ok", Date.now(), { ruleId: task.ruleId, commit: fix.commit, changedFiles: patch.changes.length });
  }

  private async runProductionChecks(checks: ProductionCheck[]): Promise<ProductionCheckResult[]> {
    const output = CheckOutputSchema.parse(await this.target({ action: "checks", checks, privateDiagnostics: this.privateDiagnostics }));
    if (output.checks.length !== checks.length || checks.some(check => !output.checks.some(result => result.check === check))) throw new Error("Target omitted a production check");
    for (const check of output.checks) await this.recordStep(check.check, check.status === "passed" ? "ok" : check.status === "unavailable" ? "skipped" : "error", Date.now() - check.durationMs, { exitCode: check.exitCode, available: check.available });
    return output.checks;
  }

  private async checkSelection(fixIds: readonly string[]): Promise<FinalCheckSnapshot> {
    this.finalSequence += 1;
    const materialized = await this.journal.materialize(fixIds);
    const transfer = await mkdtemp(join(this.runRoot, "production-input-"));
    try {
      await copyTargetSnapshot(materialized.path, transfer);
      await this.target({ action: "reset-source" });
      await dockerCopy(`${transfer}/.`, this.sandbox.application, "/workspace");
      // Existing dependencies stay in the container; transferred source is owned by the unprivileged application user.
      await dockerExec(this.sandbox.application, ["chown", "-R", "pwuser:pwuser", "/workspace"]);
      this.currentFixSet = JSON.stringify(fixIds);
      this.finalChecks = await this.runProductionChecks(checkNames);
      const snapshot = snapshotFromChecks(this.finalChecks);
      snapshot.build.push(...materialized.replayFailures.map(id => `patch-replay:${createHash("sha256").update(id).digest("hex").slice(0, 16)}`));
      if (this.finalChecks.find(check => check.check === "build")?.status === "passed") {
        await this.target({ action: "start", mode: "production" });
        await this.ready(this.routes[0] ?? "/");
        this.finalObservations = await this.scan(this.routes, `production-final-${this.finalSequence}`);
        snapshot.violations = observationsToState(this.finalObservations).violations.map(violationKey);
        const selectedTasks = fixIds.map(id => {
          const task = this.tasks.get(id);
          if (!task) throw new Error("Selected production fix lost its task provenance");
          return task;
        });
        snapshot.violations.push(...unresolvedProductionTargets(selectedTasks, observationsToState(this.finalObservations)));
        const aggregate: FixTask = { id: "production-preservation", ruleId: "unknown", criterion: "unknown", kind: "human", route: "human", source: null, routes: this.routes, violations: [] };
        const preservation = verifyPerPatch({ task: aggregate, before: observationsToState(this.productionBaseline), after: observationsToState(this.finalObservations) });
        if (!preservation.accepted && preservation.check !== "new-violation") snapshot.violations.push(`production-preservation:${preservation.check}:${createHash("sha256").update(preservation.reason ?? "").digest("hex").slice(0, 16)}`);
      } else {
        this.finalObservations = [];
        snapshot.violations.push("production-scan-unavailable:build-failed");
      }
      return snapshot;
    } finally { await materialized.close(); await rm(transfer, { recursive: true, force: true }); }
  }

  async verifyFinal(): Promise<FinalVerificationResult> {
    await this.target({ action: "stop" });
    const baseline = snapshotFromChecks(this.baselineChecks);
    baseline.violations = observationsToState(this.productionBaseline).violations.map(violationKey);
    const result = await verifyFixSet({ baseline, fixIds: this.journal.fixes.map(fix => fix.id), runChecks: ids => this.checkSelection(ids),
      rerunTests: async ids => {
        if (JSON.stringify(ids) !== this.currentFixSet) await this.checkSelection(ids);
        const rerun = await this.runProductionChecks(["tests"]);
        return rerun.flatMap(check => check.failureIds);
      } });
    this.finalResult = result;
    await writeFile(join(this.evidenceDir, "final-verification.json"), JSON.stringify({ result, checks: this.finalChecks, productionPasses: this.finalSequence }, null, 2));
    return result;
  }

  async finalPatch(): Promise<Patch | null> {
    const result = this.finalResult;
    if (!result || result.failures.length > 0) throw new Error("A successful final verification is required before source application");
    if (result.acceptedFixIds.length === 0) return null;
    const selected = await this.journal.materialize(result.acceptedFixIds);
    try {
      if (selected.replayFailures.length > 0) throw new Error("Verified commits no longer replay cleanly");
      const paths = new Set(this.journal.fixes.filter(fix => result.acceptedFixIds.includes(fix.id)).flatMap(fix => fix.patch.changes.map(change => change.path)));
      const changes: Patch["changes"] = [];
      for (const path of paths) {
        const first = this.journal.fixes.flatMap(fix => fix.patch.changes).find(change => change.path === path);
        if (!first) throw new Error("Missing source baseline");
        const after = await readFile(await resolveSafeSource(selected.path, path), "utf8");
        if (first.before !== after) changes.push({ path, before: first.before, after });
      }
      return changes.length === 0 ? null : PatchSchema.parse({ taskId: "verified-run", changes });
    } finally { await selected.close(); }
  }

  async close(): Promise<void> {
    await this.sandbox.close();
    await rm(this.sourceRoot, { recursive: true, force: true });
    for (const name of configNames) await rm(join(this.runRoot, `instrumented-${name}`), { force: true });
    await clearPrivateEvidence(this.evidenceDir, this.retainEvidence);
  }
}
