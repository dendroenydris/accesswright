import { createHash } from "node:crypto";
import { partitionRouteScans, validateRouteScanChunk } from "./scan-batches.js";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaults, loadConfig } from "../config.js";
import { AccesswrightConfigSchema, PatchSchema } from "../types/schemas.js";
import type { AccesswrightConfig, FixTask, Patch } from "../types/schemas.js";
import { copyTargetSnapshot, resolveSafeSource } from "../sandbox/source-boundary.js";
import { applyTransferredPatch } from "../sandbox/source-transfer.js";
import type { RepairTransport } from "../sandbox/repair-transport.js";
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
import { dependencyInstallPlan, installedToolingRoot, instrumentationPackagePath, toolingRoot } from "./install-plan.js";
import { PatchJournal, listSnapshotFiles } from "./patch-journal.js";
import { instrumentConfigSource } from "./config-merge.js";
import { clearPrivateEvidence, recordPrivateScan } from "./evidence-retention.js";
import { PackageManifestSchema, snapshotFromChecks } from "./production-checks.js";
import type { ProductionCheck, ProductionCheckResult } from "./production-checks.js";
import { BrowserCommandSchema, BrowserScanOutputSchema, CheckOutputSchema, CrawlOutputSchema, TargetCommandSchema, TargetInspectionSchema, sourceRoutesForChanges } from "./session-protocol.js";

const targetEnvironment = { ACCESSWRIGHT_ISOLATED_TARGET: "1", HOME: "/home/pwuser", NEXT_TELEMETRY_DISABLED: "1", CI: "1" };
const checkNames: ProductionCheck[] = ["build", "typecheck", "lint", "tests"];
const configNames = ["next.config.mjs", "next.config.js", "next.config.ts", "next.config.cjs", "next.config.mts", "next.config.cts"];

export interface RepairSessionOptions {
  repoPath: string;
  tempRoot: string;
  runtimeRoot: string;
  /** Optional frozen compiled runtime; dependencies/package still come from runtimeRoot. */
  runtimeDistRoot?: string;
  config?: z.input<typeof AccesswrightConfigSchema>;
  /** Opt-in local diagnostics for owned fixtures; never enabled by hosted or normal CLI defaults. */
  privateDiagnostics?: boolean;
  retainEvidence?: boolean;
  /** Called after every recorded run step, for progress display. */
  onStep?: (step: RunStepEvent) => void;
  /**
   * Baseline measured by another session on the byte-identical source (evaluation systems of one batch). The new session
   * still installs and runs in its own containers, but skips the baseline checks and scans, which dominate preparation.
   */
  baseline?: SharedBaseline;
}

export interface RunStepEvent {
  step: string;
  status: "ok" | "error" | "rejected" | "skipped";
  durationMs: number;
  metadata: Record<string, string | number | boolean | null>;
}

export interface SharedBaseline {
  sourceDigest: string;
  routes: string[];
  baselineChecks: ProductionCheckResult[];
  productionBaseline: BrowserObservation[];
  observations: BrowserObservation[];
  volatileText: string[];
}

async function snapshotDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await listSnapshotFiles(root)) {
    const bytes = await readFile(join(root, file));
    hash.update(file).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

export class UnsupportedRepositoryError extends Error {
  readonly evidenceDir: string;
  constructor(message: string, evidenceDir: string) { super(message); this.evidenceDir = evidenceDir; this.name = "UnsupportedRepositoryError"; }
}

export class RepairSession<TSandbox extends RepairTransport> {
  readonly sourceRoot: string;
  readonly evidenceDir: string;
  readonly config: AccesswrightConfig;
  readonly journal: PatchJournal;
  readonly sandbox: TSandbox;
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
  private sourceChanged = false;
  private readonly volatileText = new Set<string>();
  private readonly privateDiagnostics: boolean;
  private readonly retainEvidence: boolean;
  private readonly onStep: ((step: RunStepEvent) => void) | undefined;

  protected constructor(options: RepairSessionOptions, config: AccesswrightConfig, runRoot: string, journal: PatchJournal, sandbox: TSandbox) {
    this.repoPath = options.repoPath; this.config = config; this.runRoot = runRoot; this.onStep = options.onStep;
    this.sourceRoot = join(runRoot, "source"); this.evidenceDir = join(runRoot, "evidence");
    this.journal = journal; this.sandbox = sandbox;
    this.privateDiagnostics = options.privateDiagnostics === true;
    this.retainEvidence = options.retainEvidence === true || this.privateDiagnostics;
  }

  get applicationContainer(): string { return this.sandbox.application; }

  protected static async prepareWithSandbox<TTransport extends RepairTransport>(
    options: RepairSessionOptions,
    createSandbox: (evidenceDir: string, config: AccesswrightConfig) => Promise<TTransport>,
  ): Promise<RepairSession<TTransport>> {
    const prepareStarted = Date.now();
    const config = options.config === undefined ? await loadConfig(options.repoPath) : AccesswrightConfigSchema.parse(options.config);
    await mkdir(options.tempRoot, { recursive: true });
    const runRoot = await mkdtemp(join(options.tempRoot, "repair-run-"));
    const sourceRoot = join(runRoot, "source"), evidenceDir = join(runRoot, "evidence");
    await mkdir(evidenceDir);
    let session: RepairSession<TTransport> | undefined;
    try {
      await copyTargetSnapshot(options.repoPath, sourceRoot);
      const files = await listSnapshotFiles(sourceRoot);
      const manifest = PackageManifestSchema.parse(JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8")));
      const install = dependencyInstallPlan(files, manifest);
      if (!(manifest.dependencies.next ?? manifest.devDependencies.next)) throw new UnsupportedRepositoryError("The source is not an eligible Next.js repository", evidenceDir);
      const fileRoutes = discoverFileRoutes(files);
      if (fileRoutes.length === 0) throw new UnsupportedRepositoryError("No eligible application routes were discovered", evidenceDir);
      const journal = await PatchJournal.create(sourceRoot);
      const runtimeDistRoot = options.runtimeDistRoot ?? join(options.runtimeRoot, "dist");
      const sandbox = await createSandbox(evidenceDir, config);
      session = new this(options, config, runRoot, journal, sandbox);
      await access(join(runtimeDistRoot, "src/runner/target-entry.js"));
      await sandbox.create(sourceRoot);
      await session.recordStep("sandbox", "ok", prepareStarted, { driver: sandbox.kind });
      const installStarted = Date.now();
      const created = await sandbox.exec("application", ["mkdir", "-p", toolingRoot]);
      if (created.exitCode !== 0) throw new Error("Isolated tooling directory preparation failed");
      await sandbox.ownWorkspace([toolingRoot]);
      const tools = await sandbox.exec("application", install.tooling,
        { user: "pwuser", environment: targetEnvironment, timeoutMs: defaults.installTimeoutMs });
      if (tools.exitCode !== 0) throw new UnsupportedRepositoryError("Isolated tooling installation failed", evidenceDir);
      const installed = await sandbox.exec("application", install.target,
        { user: "pwuser", environment: targetEnvironment, timeoutMs: defaults.installTimeoutMs });
      await session.recordStep("install", installed.exitCode === 0 ? "ok" : "error", installStarted, { exitCode: installed.exitCode });
      if (installed.exitCode !== 0) throw new UnsupportedRepositoryError(`Dependency installation failed (exit ${installed.exitCode})`, evidenceDir);
      // Turbopack must resolve the injected client module inside the project root.
      // Move (do not duplicate) the isolated tooling after the frozen target install.
      const moved = await sandbox.exec("application", ["node", "-e", "const fs=require('fs');const [from,to]=process.argv.slice(1);if(fs.existsSync(to))throw Error('Reserved tooling path already exists');fs.renameSync(from,to);", toolingRoot, installedToolingRoot]);
      if (moved.exitCode !== 0) throw new Error("Isolated tooling transfer failed");
      session.inspection = TargetInspectionSchema.parse(await session.target({ action: "inspect" }));
      if (session.inspection.privateFilesPresent.length > 0) throw new Error("Private target configuration crossed the snapshot boundary");
      await sandbox.finishInstall();
      const initial = fileRoutes.find(route => !route.dynamic)?.pattern ?? config.routes[0];
      const shared = options.baseline;
      if (shared) {
        if (shared.sourceDigest !== await snapshotDigest(sourceRoot)) throw new Error("A shared baseline must come from byte-identical source");
        await writeFile(join(evidenceDir, "baseline-checks.json"), JSON.stringify(shared.baselineChecks, null, 2));
      } else {
        session.baselineChecks = await session.runProductionChecks(checkNames);
        await writeFile(join(evidenceDir, "baseline-checks.json"), JSON.stringify(session.baselineChecks, null, 2));
        if (session.baselineChecks.find(check => check.check === "build")?.status !== "passed") {
          throw new UnsupportedRepositoryError("The unmodified production baseline does not build", evidenceDir);
        }
        await session.target({ action: "start", mode: "production" });
        if (!initial) throw new UnsupportedRepositoryError("Dynamic-only applications require an explicit route", evidenceDir);
        await session.ready(initial);
        const crawled = initial === "/" ? CrawlOutputSchema.parse(await session.browser({ action: "crawl", baseUrl: sandbox.baseUrl })).paths : config.routes;
        session.routes = [...new Set([...materializeRoutes(fileRoutes, crawled).map(route => route.urlPath), ...config.routes])].sort().slice(0, defaults.maxRoutes);
        session.productionBaseline = await session.scan(session.routes, "production-baseline");
        // A second unpatched scan reveals text that changes on its own (animations); only those nodes skip text equality.
        session.learnVolatileText(session.productionBaseline, await session.scan(session.routes, "production-baseline-confirm"));
        await session.target({ action: "stop" });
      }
      if (!initial) throw new UnsupportedRepositoryError("Dynamic-only applications require an explicit route", evidenceDir);
      const existingConfigs = configNames.filter(path => files.includes(path));
      if (existingConfigs.length > 1) throw new UnsupportedRepositoryError("Multiple Next configuration files are ambiguous", evidenceDir);
      const configName = existingConfigs[0] ?? "next.config.mjs";
      const originalConfig = existingConfigs[0] ? await readFile(join(sourceRoot, configName), "utf8") : "export default {};\n";
      const esm = /\.(?:mjs|mts|ts)$/.test(configName) || (configName.endsWith(".js") && manifest.type === "module");
      const instrumentation = instrumentConfigSource(originalConfig, configName, esm, session.inspection.nextVersion, instrumentationPackagePath);
      const instrumentationPath = join(runRoot, `instrumented-${configName}`);
      await writeFile(instrumentationPath, instrumentation);
      await sandbox.copyToApplication(instrumentationPath, `/workspace/${configName}`);
      await sandbox.ownWorkspace([`/workspace/${configName}`]);
      await session.target({ action: "start", mode: "dev" });
      await session.ready(initial);
      if (shared) {
        session.adoptBaseline(shared);
        await session.recordStep("prepare", "ok", installStarted, { routeCount: session.routes.length, sharedBaseline: true });
        return session;
      }
      session.observations = await session.scan(session.routes, "dev-baseline");
      // A third unpatched sample catches rotating content that matched by chance in the two production scans.
      session.learnVolatileText(session.productionBaseline, session.observations);
      // Routes with findings are observed twice. Unstable findings remain evidence, not silently accepted fixes.
      const unstableRoutes = session.observations.filter(page => page.violations.length > 0).map(page => page.route);
      if (unstableRoutes.length > 0) {
        const confirmed = await session.scan([...new Set(unstableRoutes)], "dev-baseline-confirm");
        session.learnVolatileText(session.observations, confirmed);
        session.updateObservations(confirmed);
      }
      session.baselineObservations = structuredClone(session.observations);
      await session.recordStep("prepare", "ok", installStarted, { routeCount: session.routes.length, baselineViolationCount: observationsToState(session.observations).violations.length });
      return session;
    } catch (error) {
      try {
        await appendRunRecord(join(evidenceDir, "run.jsonl"), { timestamp: new Date().toISOString(), step: "prepare", status: "error", durationMs: Date.now() - prepareStarted, metadata: { errorClass: error instanceof Error ? error.name : "unknown" } });
        if (session?.privateDiagnostics) {
          try {
            const diagnostic = await session.sandbox.exec("application", ["tail", "-c", "12000", "/tmp/accesswright/server.log"], { user: "pwuser", environment: targetEnvironment, timeoutMs: 10000 });
            if (diagnostic.exitCode === 0) await writeFile(join(evidenceDir, "startup-diagnostic.txt"), diagnostic.stdout, { mode: 0o600 });
          } catch { await session.recordStep("private-diagnostic", "skipped", Date.now()); }
        }
      } finally {
        if (session) await session.close();
        else await rm(sourceRoot, { recursive: true, force: true });
      }
      throw error;
    }
  }

  private async recordStep(step: string, status: "ok" | "error" | "rejected" | "skipped", started: number, metadata: Record<string, string | number | boolean | null> = {}): Promise<void> {
    const durationMs = Date.now() - started;
    await appendRunRecord(join(this.evidenceDir, "run.jsonl"), { timestamp: new Date().toISOString(), step, status, durationMs, metadata });
    this.onStep?.({ step, status, durationMs, metadata });
  }

  private async target(input: z.input<typeof TargetCommandSchema>): Promise<unknown> {
    const command = TargetCommandSchema.parse(input);
    const result = await this.sandbox.exec("application", ["node", "/accesswright/dist/src/runner/target-entry.js", JSON.stringify(command)],
      { user: "pwuser", environment: targetEnvironment, timeoutMs: defaults.productionCheckTimeoutMs * 4 + defaults.readyTimeoutMs });
    if (result.exitCode !== 0) throw new Error(`Isolated target ${command.action} failed (exit ${result.exitCode}); diagnostic ${createHash("sha256").update(result.stderr).digest("hex").slice(0, 16)}`);
    return JSON.parse(result.stdout) as unknown;
  }

  private async browser(input: z.input<typeof BrowserCommandSchema>): Promise<unknown> {
    const command = BrowserCommandSchema.parse(input);
    const result = await this.sandbox.exec("browser", ["node", "/accesswright/dist/src/scanner/browser-session-entry.js", JSON.stringify(command)], { timeoutMs: defaults.productionCheckTimeoutMs * 2 });
    if (result.exitCode !== 0) {
      if (this.privateDiagnostics) {
        await writeFile(join(this.evidenceDir, "browser-" + command.action + "-diagnostic.txt"), result.stderr.slice(-12000), { mode: 0o600 });
      }
      throw new Error(`Isolated browser ${command.action} failed (exit ${result.exitCode}); diagnostic ${createHash("sha256").update(result.stderr).digest("hex").slice(0, 16)}`);
    }
    return JSON.parse(result.stdout) as unknown;
  }

  private async ready(route: string): Promise<void> { z.object({ ready: z.literal(true) }).parse(await this.browser({ action: "ready", baseUrl: this.sandbox.baseUrl, route })); }

  async readSource(path: string): Promise<string> { return readFile(await resolveSafeSource(this.sourceRoot, path), "utf8"); }

  async applyPatch(patch: Patch): Promise<Patch> {
    this.sourceChanged = true;
    return applyTransferredPatch(this.sourceRoot, patch, async path => {
      await this.sandbox.copyToApplication(join(this.sourceRoot, path), `/workspace/${path}`);
      await this.sandbox.ownWorkspace([`/workspace/${path}`]);
    });
  }

  async revertPatch(patch: Patch): Promise<void> { await this.applyPatch({ taskId: patch.taskId, changes: patch.changes.map(change => ({ ...change, before: change.after, after: change.before })) }); }

  async scan(routes: readonly string[], generation: string): Promise<BrowserObservation[]> {
    const started = Date.now();
    const chunks = partitionRouteScans(routes, 6);
    const observations: BrowserObservation[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const chunkStarted = Date.now();
      try {
        if (this.sourceChanged) for (const route of chunk) await this.ready(route);
        const part = BrowserScanOutputSchema.parse(await this.browser({
          action: "scan", baseUrl: this.sandbox.baseUrl, routes: chunk, generation,
          mobile: this.config.scan.mobile, dark: this.config.scan.darkScheme, interactions: true,
          ...(this.config.scan.ibm === undefined ? {} : { ibm: this.config.scan.ibm }),
          ...(this.config.scan.keyboard === undefined ? {} : { keyboard: this.config.scan.keyboard }),
        }));
        validateRouteScanChunk(chunk, part.observations, this.config.scan.mobile);
        observations.push(...part.observations);
        await this.recordStep("scan-batch", "ok", chunkStarted, {
          generation, batch: index, totalBatches: chunks.length, routeCount: chunk.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown";
        await this.recordStep("scan-batch", "error", chunkStarted, {
          generation, batch: index, totalBatches: chunks.length, routeCount: chunk.length,
          errorClass: error instanceof Error ? error.name : "unknown",
          diagnostic: createHash("sha256").update(message).digest("hex").slice(0, 16),
        });
        throw new Error("Isolated browser route batch failed; its incomplete scan cannot be accepted", { cause: error });
      }
    }
    const output = BrowserScanOutputSchema.parse({ observations });
    validateRouteScanChunk(routes, output.observations, this.config.scan.mobile);
    this.markVolatileText(output.observations);
    await this.sandbox.syncEvidence(output.observations.flatMap(page => [page.screenshot, ...page.contexts.map(context => context.screenshot)].filter((name): name is string => name !== null)));
    await recordPrivateScan(this.evidenceDir, generation, output.observations, this.retainEvidence);
    await this.recordStep("scan", "ok", started, { routeCount: routes.length, observationCount: output.observations.length, generation, ibm: this.config.scan.ibm === true, keyboard: this.config.scan.keyboard === true });
    this.sourceChanged = false;
    return output.observations;
  }

  affectedRoutes(paths: readonly string[]): string[] {
    const map: Record<string, string[]> = {};
    for (const page of this.observations) for (const file of page.sourceFiles) map[file] = [...new Set([...(map[file] ?? []), page.route])];
    return sourceRoutesForChanges(paths, map, this.routes);
  }

  /** Call right after preparation, before any patch: the digest binds the baseline to the unpatched source. */
  async sharedBaseline(): Promise<SharedBaseline> {
    if (this.journal.fixes.length > 0) throw new Error("A shared baseline must be taken before any patch");
    return structuredClone({ sourceDigest: await snapshotDigest(this.sourceRoot), routes: this.routes, baselineChecks: this.baselineChecks,
      productionBaseline: this.productionBaseline, observations: this.baselineObservations, volatileText: [...this.volatileText] });
  }

  private adoptBaseline(shared: SharedBaseline): void {
    this.routes = [...shared.routes];
    this.baselineChecks = structuredClone(shared.baselineChecks);
    this.productionBaseline = structuredClone(shared.productionBaseline);
    this.observations = structuredClone(shared.observations);
    for (const id of shared.volatileText) this.volatileText.add(id);
    this.markVolatileText([...this.productionBaseline, ...this.observations]);
    this.baselineObservations = structuredClone(this.observations);
    // Patched routes are probed for readiness before their first scan, as after any source change.
    this.sourceChanged = true;
  }

  /** Only unpatched baseline scans feed this set, so a candidate patch cannot make its own text changes volatile. */
  private learnVolatileText(first: readonly BrowserObservation[], second: readonly BrowserObservation[]): void {
    const text = new Map(first.flatMap(page => page.aria.map(node => [node.id, node.text] as const)));
    for (const node of second.flatMap(page => page.aria)) {
      const previous = text.get(node.id);
      if (previous !== undefined && previous !== node.text) this.volatileText.add(node.id);
    }
    this.markVolatileText([...first, ...second, ...this.productionBaseline, ...this.observations]);
  }

  private markVolatileText(observations: readonly BrowserObservation[]): void {
    for (const node of observations.flatMap(page => page.aria)) if (this.volatileText.has(node.id)) node.volatileText = true;
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
      await this.sandbox.copyToApplication(`${transfer}/.`, "/workspace");
      // Existing dependencies stay in the container; transferred source is owned by the unprivileged application user.
      await this.sandbox.ownWorkspace(["/workspace"]);
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
    try { await this.sandbox.close(); }
    finally {
      for (const name of await readdir(this.runRoot)) {
        if (name !== "evidence") await rm(join(this.runRoot, name), { recursive: true, force: true });
      }
      await clearPrivateEvidence(this.evidenceDir, this.retainEvidence);
    }
  }
}
