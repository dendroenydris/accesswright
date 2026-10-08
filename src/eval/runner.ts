import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { z } from "zod";
import { defaults } from "../config.js";
import { runRepair } from "../core/repair.js";
import { AiSdkLlmProvider } from "../llm/ai-sdk-provider.js";
import type { ModelPricing } from "../llm/ai-sdk-provider.js";
import { BudgetLedger } from "../llm/budget.js";
import { LlmClient } from "../llm/client.js";
import { DurableBudgetProvider } from "../llm/durable-provider.js";
import type { DurableProviderOptions } from "../llm/durable-provider.js";
import { resolveExecutionModel } from "../llm/execution-policy.js";
import { createSemanticRepair } from "../llm/semantic-runner.js";
import { createSuggestOnlyRepair } from "../llm/suggest-only.js";
import type { LlmProvider } from "../llm/types.js";
import { makeRunReport } from "../reporter/report.js";
import { summarizeScans } from "../reporter/scan-summary.js";
import { DockerRepairSession, UnsupportedRepositoryError } from "../runner/repair-session.js";
import { copyTargetSnapshot, resolveSafeSource } from "../sandbox/source-boundary.js";
import { violationKey } from "../scanner/browser-facts.js";
import { appendRunRecord } from "../tracer/run-record.js";
import { freezeRenderedCases, injectedTargets, scoreCases } from "./cases.js";
import type { RenderedCase } from "./cases.js";
import { planCaseBatches, taskMatchesCases } from "./batches.js";
import { compareCleanControls } from "./controls.js";
import { applyMutations, generateMutations } from "./operators.js";
import { EvalProtocolSchema, EvalSystemSchema, systemPolicy } from "./protocol.js";
import type { EvalProtocol, EvalSystem, FrozenProtocol } from "./protocol.js";
import { EvalCellSchema, aggregateEvaluation, renderEvaluationReport } from "./report.js";
import type { EvalCell } from "./report.js";
import { fetchPinnedRepository } from "./repository.js";
import { evalCellFileName, evalReferenceFileName, loadEvalResumeState } from "./resume.js";
import type { EvalReference } from "./resume.js";

export interface EvalSelection {
  split: "dev" | "test";
  systems?: EvalSystem[];
  seeds?: number[];
  repositories?: string[];
}
export function resolveEvalSelection(raw: EvalProtocol, selection: EvalSelection) {
  const protocol = EvalProtocolSchema.parse(raw);
  const split = z.enum(["dev", "test"]).parse(selection.split);
  const systems = (selection.systems ?? protocol.systems).map(system => EvalSystemSchema.parse(system));
  const seeds = selection.seeds ?? protocol.seeds[split];
  const names = selection.repositories ?? protocol.repositories.filter(repository => repository.split === split).map(repository => repository.repository);
  if (!systems.length || !seeds.length || !names.length) throw new Error("Evaluation selection must not be empty");
  if (new Set(systems).size !== systems.length || new Set(seeds).size !== seeds.length || new Set(names.map(name => name.toLowerCase())).size !== names.length) throw new Error("Duplicate evaluation selection");
  if (systems.some(system => !protocol.systems.includes(system))) throw new Error("System is outside the frozen protocol");
  if (seeds.some(seed => !protocol.seeds[split].includes(seed))) throw new Error("Seed is outside the frozen split");
  const repositories = names.map(name => {
    const repository = protocol.repositories.find(repository => repository.repository.toLowerCase() === name.toLowerCase() && repository.split === split);
    if (!repository) throw new Error("Repository is outside the frozen split");
    return repository;
  });
  return { split, systems, seeds, repositories };
}

/** Fingerprint the actual compiled runtime. This does not include absolute host paths or private documents. */
export async function implementationDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  let count = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Compiled runtime must not contain symbolic links");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        const bytes = await readFile(path);
        hash.update(relative(root, path)).update("\0").update(String(bytes.length)).update("\0").update(bytes);
        count += 1;
      }
    }
  }
  await visit(root);
  if (!count) throw new Error("No compiled implementation was found");
  return hash.digest("hex");
}

/** Freeze only compiled code. Large trusted dependencies remain read-only at runtimeRoot. */
export async function snapshotCompiledRuntime(runtimeRoot: string, outputDir: string): Promise<{ path: string; digest: string }> {
  const source = join(runtimeRoot, "dist");
  const before = await implementationDigest(source);
  const path = join(outputDir, "runtime");
  await cp(source, path, { recursive: true, errorOnExist: true, force: false });
  const digest = await implementationDigest(path);
  const after = await implementationDigest(source);
  if (before !== after || digest !== before) throw new Error("Compiled implementation changed while creating the evaluation snapshot");
  return { path, digest };
}

export interface EvalRunOptions extends EvalSelection {
  frozen: FrozenProtocol;
  runtimeRoot: string;
  tempRoot: string;
  outputDir: string;
  cacheRoot: string;
  /** Explicit smoke-subset bound, retained in the manifest; never changes the frozen target. */
  caseLimit?: number;
  /** Resume matching persisted cells without mixing frozen implementations or duplicating calls. */
  resume?: boolean;
  pricing?: ModelPricing;
  maxRunCostUsd?: number;
  durableBudget?: Pick<DurableProviderOptions, "ledger" | "maxInputTokens" | "expiresAt">;
  /** Injection is always labeled fake-provider, never provider-api. */
  providerFactory?: (system: EvalSystem) => LlmProvider;
  /** Only a controlled-fixtures protocol may use local source instead of the frozen Git fetch. */
  fixtureRoots?: Readonly<Record<string, string>>;
  onProgress?: (event: Record<string, string | number | boolean | null>) => void;
}

function diagnostic(error: unknown): string {
  if (error instanceof UnsupportedRepositoryError) return error.message;
  const name = error instanceof Error ? error.name : "unknown-error";
  return `${name}; diagnostic ${createHash("sha256").update(error instanceof Error ? error.message : String(error)).digest("hex").slice(0,16)}`;
}
function emptyCell(options: EvalRunOptions, implementation: string, repository: EvalProtocol["repositories"][number], system: EvalSystem, seed: number, batch: number): EvalCell {
  const now = new Date().toISOString();
  return EvalCellSchema.parse({ schemaVersion: 1, protocolDigest: options.frozen.digest, implementationDigest: implementation, repository: repository.repository, sha: repository.sha,
    corpus: options.frozen.protocol.corpus, split: repository.split, seed, batch, system, model: options.frozen.protocol.model,
    providerMode: system === "deterministic" ? "none" : options.providerFactory ? "fake" : options.durableBudget ? "live" : "none", providerEvidence: "not-run", startedAt: now, finishedAt: now, durationMs: 0, status: "blocked", reason: null, cases: [], exclusions: [], verification: [],
    usage: { spentUsd: 0, inputTokens: 0, outputTokens: 0, unknownUsage: false }, controls: { observed: 0, changed: 0, unexpectedEditedFiles: [] }, newViolations: 0, report: null });
}

async function executeCell(options: EvalRunOptions, runtimeDistRoot: string, base: EvalCell, repoPath: string, candidates: readonly RenderedCase[]): Promise<EvalCell> {
  const started = Date.now();
  const cell = structuredClone(base);
  const policy = systemPolicy(cell.system);
  const limit = z.number().finite().nonnegative().parse(options.maxRunCostUsd ?? defaults.maxRunCostUsd);
  const budget = new BudgetLedger({ maxRunCostUsd: limit, maxTaskTokens: defaults.maxTaskTokens });
  let session: DockerRepairSession | undefined;
  let eligible: RenderedCase[] = [];
  let providerCalls = 0;
  try {
    if (policy.usesLlm && (!options.pricing || limit <= 0 || (!options.providerFactory && !options.durableBudget))) {
      cell.reason = "Live comparison requires operator pricing, a run cap, and a durable cumulative allowance; fake-provider injection is separate";
      return cell;
    }
    session = await DockerRepairSession.prepare({ repoPath, tempRoot: options.tempRoot, runtimeRoot: options.runtimeRoot, runtimeDistRoot, retainEvidence: true, config: { scan: { mobile: true, darkScheme: false } } });
    cell.evidenceId = basename(session.runRoot);
    const injection = injectedTargets(candidates, session.observations);
    eligible = injection.eligible;
    cell.exclusions = injection.excluded;
    if (!eligible.length) { cell.status = "unsupported"; cell.reason = "No selected mutation produced a confirmed target"; return cell; }
    const model = resolveExecutionModel(options.frozen.protocol.model);
    const pricing = options.pricing;
    let client: LlmClient | undefined;
    if (policy.usesLlm && pricing) {
      const provider = options.providerFactory?.(cell.system) ?? new AiSdkLlmProvider({ pricing: requested => requested.provider === model.provider && requested.id === model.id ? pricing : null });
      const metered = options.durableBudget ? new DurableBudgetProvider(provider, { ...options.durableBudget, model, pricing }) : provider;
      client = new LlmClient(metered, async event => {
        providerCalls += 1;
        await appendRunRecord(join(session?.evidenceDir ?? options.outputDir, "run.jsonl"), { timestamp: new Date().toISOString(), step: "llm", status: event.status, model: event.model,
          ...(event.usage ? { usage: event.usage } : {}), metadata: { taskType: event.taskType, promptHash: event.promptHash } });
      });
    }
    const semanticRepair = client && pricing && policy.enrichedContext ? createSemanticRepair({ session, client, budget, model, pricing, maxAttempts: policy.attempts }) : undefined;
    const proposalRepair = client && pricing && !policy.enrichedContext ? createSuggestOnlyRepair({ client, budget, model, pricing, readSource: path => session ? session.readSource(path) : Promise.reject(new Error("Missing evaluation session")) }) : undefined;
    const result = await runRepair(session, { noLlm: !policy.usesLlm, maxTasks: Math.max(defaults.maxTasks, eligible.length),
      ...(semanticRepair ? { semanticRepair } : {}), ...(proposalRepair ? { proposalRepair } : {}), includeTask: task => taskMatchesCases(task, eligible),
      onVerification: (task, verdict) => { cell.verification.push({ taskId: task.id, caseIds: eligible.filter(item => taskMatchesCases(task, [item])).map(item => item.mutation.id), accepted: verdict.accepted, check: verdict.check }); },
    });
    cell.providerEvidence = providerCalls ? options.providerFactory ? "fake-provider" : "provider-api" : "not-run";
    cell.cases = scoreCases(eligible, session.finalObservations, result.status === "verified");
    const editedFiles = session.journal.fixes.filter(fix => result.final.acceptedFixIds.includes(fix.id)).flatMap(fix => fix.patch.changes.map(change => change.path));
    const allowedFiles = new Set(session.baselineObservations.flatMap(page => page.violations.map(violation => violation.source?.file).filter((file): file is string => file !== undefined)));
    cell.controls = compareCleanControls(session.productionBaseline, session.finalObservations, eligible, editedFiles, allowedFiles);
    const previous = new Set(session.productionBaseline.flatMap(page => page.violations.map(violationKey)));
    cell.newViolations = session.finalObservations.flatMap(page => page.violations).filter(violation => !previous.has(violationKey(violation))).length;
    cell.report = makeRunReport({ result, startedAt: cell.startedAt, finishedAt: new Date().toISOString(), applied: false, checks: session.finalChecks, usage: budget.snapshot(), unknownUsage: budget.hasUnknownUsage(), providerVerification: cell.providerEvidence,
      scanSummary: summarizeScans(session.productionBaseline, session.finalObservations, session.baselineObservations) });
    await writeFile(join(session.evidenceDir,"report.json"),JSON.stringify(cell.report,null,2));
    cell.status = "completed";
    cell.reason = result.status === "blocked" ? "Final gate rejected this fix set" : null;
  } catch (error) {
    cell.reason = diagnostic(error);
    cell.status = error instanceof UnsupportedRepositoryError ? "unsupported" : "blocked";
    cell.cases = scoreCases(eligible, [], false);
  } finally {
    cell.providerEvidence = providerCalls ? options.providerFactory ? "fake-provider" : "provider-api" : "not-run";
    const { spentUsd, inputTokens, outputTokens } = budget.snapshot();
    cell.usage = { spentUsd, inputTokens, outputTokens, unknownUsage: budget.hasUnknownUsage() };
    if (session) {
      try { await session.close(); }
      catch (error) { cell.status = "blocked"; cell.reason = `Cleanup failed: ${diagnostic(error)}`; }
    }
    cell.finishedAt = new Date().toISOString(); cell.durationMs = Date.now()-started;
  }
  return EvalCellSchema.parse(cell);
}

/** Genuine fixture incompatibility is not interchangeable with transport or resource failure. */
export function classifyOriginalPreparationError(error: unknown): "unsupported" | "blocked" {
  return error instanceof UnsupportedRepositoryError ? "unsupported" : "blocked";
}

/** Executes one immutable corpus selection. Every source project executes only inside the secret-free Docker runner. */
export async function runEvaluation(options: EvalRunOptions) {
  const protocol = EvalProtocolSchema.parse(options.frozen.protocol);
  if (createHash("sha256").update(JSON.stringify(protocol)).digest("hex") !== options.frozen.digest) throw new Error("Frozen protocol digest changed");
  const selection = resolveEvalSelection(protocol, options);
  const maximum = options.caseLimit ?? protocol.maxCasesPerRepository;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > protocol.maxCasesPerRepository) throw new Error("Case subset exceeds the frozen bound");
  if (options.fixtureRoots && protocol.corpus !== "controlled-fixtures") throw new Error("Local fixtures cannot substitute for the public corpus");
  await mkdir(options.tempRoot,{recursive:true});
  let runtimeSnapshot: { path: string; digest: string };
  let cells: EvalCell[];
  const previousReferences = new Map<string, EvalReference>();
  if (options.resume === true) {
    const currentDigest = await implementationDigest(join(options.runtimeRoot, "dist"));
    const previous = await loadEvalResumeState({
      outputDir: options.outputDir, frozen: options.frozen,
      implementationDigest: currentDigest, selection, caseLimit: maximum,
      providerInjection: Boolean(options.providerFactory),
    });
    const snapshotPath = join(options.outputDir, "runtime");
    if (await implementationDigest(snapshotPath) !== currentDigest) {
      throw new Error("Refusing to resume: immutable runtime snapshot digest changed");
    }
    runtimeSnapshot = { path: snapshotPath, digest: currentDigest };
    cells = [...previous.cells];
    for (const [key, value] of previous.references) previousReferences.set(key, value);
  } else {
    await mkdir(options.outputDir,{recursive:false});
    runtimeSnapshot = await snapshotCompiledRuntime(options.runtimeRoot, options.outputDir);
    cells = [];
    await writeFile(join(options.outputDir,"manifest.json"),JSON.stringify({ schemaVersion:1, protocol: options.frozen, implementationDigest:runtimeSnapshot.digest, runtimeSnapshot:"runtime", selection, caseLimit:maximum, providerInjection:Boolean(options.providerFactory), createdAt:new Date().toISOString() },null,2),{flag:"wx",mode:0o600});
  }
  const implementation = runtimeSnapshot.digest;
  const cellFiles = new Set(cells.map(evalCellFileName));
  const alreadyStored = (repository: EvalProtocol["repositories"][number], system: EvalSystem, seed: number, batch: number) =>
    cellFiles.has(evalCellFileName({ repository: repository.repository, sha: repository.sha, system, seed, batch }));
  const store = async (cell: EvalCell) => {
    if (await implementationDigest(runtimeSnapshot.path) !== implementation) throw new Error("Frozen evaluation runtime changed; completed cells remain on disk but cannot be pooled");
    const validated = EvalCellSchema.parse(cell);
    const filename = evalCellFileName(validated);
    if (cellFiles.has(filename)) throw new Error("Cannot store the same frozen evaluation cell twice");
    await writeFile(join(options.outputDir,filename),JSON.stringify(validated,null,2),{flag:"wx",mode:0o600});
    cellFiles.add(filename);
    cells.push(validated);
    options.onProgress?.({ repository:cell.repository, system:cell.system, seed:cell.seed, batch:cell.batch, status:cell.status, cases:cell.cases.length, correct:cell.cases.filter(item=>item.correctlyFixed).length, costUsd:cell.usage.spentUsd, reason:cell.reason });
  };
  for (const repository of selection.repositories) {
    const existingReference = previousReferences.get(repository.repository.toLowerCase());
    const allExpectedCellsPresent = existingReference?.rendered.eligible.length
      ? selection.seeds.every(seed => planCaseBatches(existingReference.rendered.eligible, seed, maximum)
          .every((_, batch) => selection.systems.every(system => alreadyStored(repository, system, seed, batch))))
      : selection.seeds.every(seed => selection.systems.every(system => alreadyStored(repository, system, seed, 0)));
    if (options.resume && allExpectedCellsPresent) {
      options.onProgress?.({ repository:repository.repository, phase:"resumed-complete" });
      continue;
    }
    let original: DockerRepairSession | undefined;
    let sourceRoot: string;
    let rendered: ReturnType<typeof freezeRenderedCases>;
    options.onProgress?.({ repository:repository.repository, phase:"prepare-original" });
    try {
      sourceRoot = options.fixtureRoots?.[repository.repository] ?? await fetchPinnedRepository(options.cacheRoot,repository.repository,repository.sha);
      original = await DockerRepairSession.prepare({ repoPath:sourceRoot,tempRoot:options.tempRoot,runtimeRoot:options.runtimeRoot,runtimeDistRoot:runtimeSnapshot.path,retainEvidence:true,config:{scan:{mobile:true,darkScheme:false}} });
      const files = [...new Set(original.observations.flatMap(page=>(page.sourceIndex??[]).filter(entry=>entry.mapping==="direct").map(entry=>entry.source.file)))].filter(path=>/\.[jt]sx?$/.test(path)).sort();
      const mutations = [];
      for (const file of files) {
        const generated = generateMutations(file, await original.readSource(file));
        mutations.push(...generated.filter(mutation => protocol.operators.includes(mutation.operator)));
      }
      rendered = freezeRenderedCases(mutations,original.observations);
      if (existingReference) {
        if (JSON.stringify(existingReference.rendered) !== JSON.stringify(rendered)) {
          throw new Error("Frozen rendered reference changed during resumed evaluation");
        }
      } else {
        await writeFile(join(options.outputDir, evalReferenceFileName(repository.repository)),
          JSON.stringify({ repository, rendered, implementationDigest:implementation },null,2),
          {flag:"wx",mode:0o600});
      }
      if (!rendered.eligible.length) throw new UnsupportedRepositoryError("No originally clean rendered targets are eligible",original.evidenceDir);
    } catch (error) {
      for (const seed of selection.seeds) for (const system of selection.systems) {
        if (!alreadyStored(repository, system, seed, 0)) {
          await store({ ...emptyCell(options,implementation,repository,system,seed,0),status:classifyOriginalPreparationError(error),reason:diagnostic(error) });
        }
      }
      continue;
    } finally { if (original) await original.close(); }
    for (const seed of selection.seeds) {
      const batches = planCaseBatches(rendered.eligible,seed,maximum);
      for (const [batch,candidates] of batches.entries()) {
        if (selection.systems.every(system => alreadyStored(repository, system, seed, batch))) continue;
        const temporary = await mkdtemp(join(options.tempRoot,"seeded-input-"));
        const mutated = join(temporary,"source");
        try {
          await copyTargetSnapshot(sourceRoot,mutated);
          for (const file of [...new Set(candidates.map(item=>item.mutation.file))]) {
            const path = await resolveSafeSource(mutated,file);
            const before = await readFile(path,"utf8");
            await writeFile(path,applyMutations(before,candidates.filter(item=>item.mutation.file===file).map(item=>item.mutation)),"utf8");
          }
          for (const system of selection.systems) {
            if (alreadyStored(repository, system, seed, batch)) continue;
            const cell = await executeCell(options,runtimeSnapshot.path,emptyCell(options,implementation,repository,system,seed,batch),mutated,candidates);
            await store(cell);
          }
        } finally { await rm(temporary,{recursive:true,force:true}); }
      }
    }
  }
  const summary = aggregateEvaluation(cells);
  await writeFile(join(options.outputDir,"summary.json"),JSON.stringify(summary,null,2),{flag:"wx",mode:0o600});
  await writeFile(join(options.outputDir,"report.md"),renderEvaluationReport(summary),{flag:"wx",mode:0o600});
  return { cells, summary, outputDir:options.outputDir };
}
