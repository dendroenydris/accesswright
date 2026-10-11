import { lstat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import { defaults } from "../config.js";
import { resolveSafeSource } from "../sandbox/source-boundary.js";
import { isSourcePath } from "../types/schemas.js";
import type { FixTask } from "../types/schemas.js";
import type { BrowserObservation } from "../scanner/observations.js";
import type { LlmImage } from "./types.js";
import { buildRepairContext, findComponentCallSites } from "./context.js";

export interface ContextGatheringInput {
  root: string;
  evidenceDir: string;
  task: FixTask;
  observations: readonly BrowserObservation[];
}

export async function gatherRepairContext(input: ContextGatheringInput) {
  const source = input.task.source;
  if (!source || !isSourcePath(source.file)) throw new Error("A mapped project source is required for deterministic context");
  const text = await readFile(await resolveSafeSource(input.root, source.file), "utf8");
  const sourceProject = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const parsed = sourceProject.createSourceFile(source.file, text);
  const offset = text.split("\n").slice(0, source.line - 1).reduce((total, line) => total + line.length + 1, 0) + source.column - 1;
  const node = parsed.getDescendantAtPos(offset);
  const functionName = node?.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration)?.getName();
  const variableName = node?.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getName();
  const name = functionName ?? variableName ?? basename(source.file).replace(/\.[^.]+$/, "");
  const pages = input.observations.filter(page => input.task.routes.includes(page.route));
  const contexts = pages.flatMap(page => page.contexts).filter(context => input.task.violations.some(violation => JSON.stringify(violation.target) === JSON.stringify(context.target)));
  const rendered = contexts.find(context => context.source?.file === source.file) ?? contexts[0];
  const relatedFiles = [...new Set(pages.flatMap(page => page.sourceFiles))].filter(file => isSourcePath(file) && /\.[jt]sx?$/.test(file) && file !== source.file).sort();
  const files: Record<string, string> = {};
  let remaining = defaults.maxContextBytes;
  for (const file of relatedFiles.slice(0, defaults.maxContextFiles)) {
    const path = await resolveSafeSource(input.root, file);
    const size = (await lstat(path)).size;
    if (size > remaining) continue;
    files[file] = await readFile(path, "utf8"); remaining -= size;
  }
  const images: LlmImage[] = [];
  const screenshot = rendered?.screenshot;
  if (screenshot) {
    if (!/^[a-zA-Z0-9_-]+\.png$/.test(screenshot)) throw new Error("Invalid screenshot evidence reference");
    const path = join(input.evidenceDir, screenshot);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > defaults.maxImageBytes) throw new Error("Image evidence is not a bounded regular file");
    const data = await readFile(path);
    if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Image evidence is not PNG data");
    images.push({ data: new Uint8Array(data), mediaType: "image/png" });
  }
  const context = buildRepairContext({ source: { ...source, text }, callSites: findComponentCallSites(files, name),
    page: { title: rendered?.pageTitle ?? null, surroundingText: rendered?.surroundingText ?? "", caption: rendered?.imageCaption ?? null, linkTarget: rendered?.linkTarget ?? null },
    // An opaque host path is never a substitute for multimodal image bytes.
    screenshotPath: null });
  return { context, images };
}
