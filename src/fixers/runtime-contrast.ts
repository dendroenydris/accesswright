import { Node, Project, SyntaxKind } from "ts-morph";
import { parse } from "culori";
import { applyInlineContrastFix } from "./contrast-patch.js";
import { choosePaletteColor, contrastRatio, optimizeContrast } from "./contrast.js";
import type { ContrastOptimization } from "./contrast.js";
import { PatchSchema } from "../types/schemas.js";
import type { FixTask, Patch } from "../types/schemas.js";
import type { BrowserObservation } from "../scanner/observations.js";

export interface RenderedContrastDecision { patch: Patch | null; reason: string | null }

/** Only local source literals/classes are edited. Shared tokens are proposed, never silently overridden. */
export function applyRenderedContrastFix(sourceText: string, task: FixTask, observations: readonly BrowserObservation[]): RenderedContrastDecision {
  const defer = (reason: string): RenderedContrastDecision => ({ patch: null, reason });
  if (task.ruleId !== "color-contrast" || task.route !== "optimizer" || !task.source) return defer("not-a-mapped-contrast-task");
  const source = task.source;
  const contexts = observations.filter(page => task.routes.includes(page.route)).flatMap(page => page.contexts).filter(context =>
    context.source?.file === source.file && context.source.line === source.line && context.source.column === source.column &&
    task.violations.some(violation => JSON.stringify(violation.target) === JSON.stringify(context.target)),
  );
  if (contexts.length === 0) {
    const patch = applyInlineContrastFix(sourceText, task);
    return { patch, reason: patch ? null : "no-rendered-contrast-context" };
  }
  if (contexts.some(context => context.mapping !== "direct")) return defer("ancestor-color-requires-call-site-review");
  if (contexts.some(context => {
    const bg = context.background === null ? undefined : parse(context.background);
    const fg = parse(context.foreground);
    return !bg || !fg || (bg.alpha ?? 1) !== 1 || (fg.alpha ?? 1) !== 1;
  })) return defer("background-or-foreground-is-not-a-known-opaque-color");
  const first = contexts[0];
  if (!first?.background) return defer("no-rendered-background");
  const passes = (color: string) => contexts.every(context => context.background !== null && contrastRatio(color, context.background) >= context.contrastTarget);
  const optimized = contexts.map(context => optimizeContrast(context.foreground, context.background ?? "", context.contrastTarget))
    .filter((candidate): candidate is ContrastOptimization => candidate !== null && passes(candidate.color))
    .sort((a, b) => a.deltaE - b.deltaE)[0];
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const file = project.createSourceFile(source.file, sourceText);
  const element = [...file.getDescendantsOfKind(SyntaxKind.JsxOpeningElement), ...file.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)]
    .find(node => { const position = file.getLineAndColumnAtPos(node.getStart()); return position.line === source.line && position.column === source.column; });
  if (!element || element.getAttributes().some(Node.isJsxSpreadAttribute)) return defer("ambiguous-local-color-source");
  const attribute = (name: string) => element.getAttributes().filter(Node.isJsxAttribute).find(item => item.getNameNode().getText() === name);
  const style = attribute("style")?.getInitializer();
  const object = Node.isJsxExpression(style) ? style.getExpression() : undefined;
  const color = Node.isObjectLiteralExpression(object) ? object.getProperty("color") : undefined;
  if (Node.isPropertyAssignment(color)) {
    const literal = color.getInitializer();
    if (!Node.isStringLiteral(literal)) return defer("dynamic-color-expression-needs-review");
    const token = /var\(\s*(--[a-zA-Z0-9_-]+)/.exec(literal.getLiteralValue())?.[1];
    if (token) return defer(`shared-token:${token}; proposed=${optimized?.color ?? "unavailable"}; deltaE2000=${optimized?.deltaE.toFixed(4) ?? "unavailable"}`);
    if (!optimized) return defer("no-single-local-color-passes-all-observed-backgrounds");
    color.setInitializer(JSON.stringify(optimized.color));
  } else {
    const classAttribute = attribute("className");
    const initializer = classAttribute?.getInitializer();
    const literal = Node.isJsxExpression(initializer) ? initializer.getExpression() : initializer;
    if (!classAttribute || !(Node.isStringLiteral(literal) || Node.isNoSubstitutionTemplateLiteral(literal))) return defer("dynamic-or-missing-class-expression-needs-review");
    const classes = literal.getLiteralValue().split(/\s+/).filter(Boolean);
    if (classes.some(name => /:text-|^!text-|^text-\[/.test(name))) return defer("variant-or-arbitrary-color-class-needs-review");
    const available = first.palette.filter(item => /^text-[a-zA-Z0-9_-]+$/.test(item.className) && parse(item.color));
    const old = classes.filter(name => available.some(item => item.className === name));
    if (old.length !== 1) return defer("runtime-palette-does-not-identify-one-local-color-class");
    const palette = available.filter(item => passes(item.color));
    // Keep the class identity attached to its score: converting a Lab/OKLCH color
    // to an 8-bit hex string is lossy, so exact Delta-E equality cannot recover it.
    const candidate = palette.map(item => ({ ...item, score: choosePaletteColor(first.foreground, first.background ?? "", [item.color], first.contrastTarget) }))
      .filter(item => item.score !== null).sort((a, b) => (a.score?.deltaE ?? Infinity) - (b.score?.deltaE ?? Infinity))[0];
    if (!candidate) return defer("no-observed-runtime-palette-color-meets-contrast");
    classAttribute.setInitializer(JSON.stringify(classes.map(name => name === old[0] ? candidate.className : name).join(" ")));
  }
  const after = file.getFullText();
  if (after === sourceText) return defer("no-source-change");
  return { patch: PatchSchema.parse({ taskId: task.id, changes: [{ path: source.file, before: sourceText, after }] }), reason: null };
}
