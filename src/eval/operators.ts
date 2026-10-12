import { createHash } from "node:crypto";
import { Node, Project, SyntaxKind } from "ts-morph";
import type { JsxOpeningElement, JsxSelfClosingElement } from "ts-morph";
import { z } from "zod";
import { isSourcePath, SourceLocationSchema } from "../types/schemas.js";
import { OperatorSchema } from "./protocol.js";
import type { Operator } from "./protocol.js";

type Opening = JsxOpeningElement | JsxSelfClosingElement;
export const MutationSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), file: z.string().refine(isSourcePath),
  component: z.string(), operator: OperatorSchema, ruleId: z.string(), source: SourceLocationSchema,
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), before: z.string().min(1), after: z.string(),
  tagName: z.string(), referenceValue: z.string().nullable(), literalId: z.string().nullable(),
}).strict();
export type Mutation = z.infer<typeof MutationSchema>;
const rules: Record<Operator, string> = { "remove-alt": "image-alt", "break-label": "label", "remove-button-name": "button-name", "remove-link-name": "link-name", "low-contrast": "color-contrast", "invalid-aria": "aria-valid-attr", "remove-lang": "html-has-lang", "positive-tabindex": "tabindex" };
function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function literal(node: Opening, name: string): string | null {
  const attribute = node.getAttribute(name);
  if (!attribute || !Node.isJsxAttribute(attribute)) return null;
  const value = attribute.getInitializer();
  return value && Node.isStringLiteral(value) ? value.getLiteralValue() : null;
}
function componentIdentity(node: Opening, file: string): string {
  const owner = node.getFirstAncestor(ancestor => Node.isFunctionDeclaration(ancestor) || Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor) || Node.isMethodDeclaration(ancestor));
  return `${file}:${owner?.getStart() ?? 0}`;
}

/** Syntax-directed reversible mutations; rendered eligibility is checked separately before scoring. */
export function generateMutations(file: string, source: string): Mutation[] {
  if (!isSourcePath(file) || !/\.[jt]sx?$/.test(file)) return [];
  if (Buffer.byteLength(source) > 2000000) throw new Error("Source exceeds the evaluation AST bound");
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const parsed = project.createSourceFile(file, source);
  // ts-morph removes the leading BOM from compiler positions.
  const bomOffset = source.startsWith("\uFEFF") ? 1 : 0;
  const nodes: Opening[] = [...parsed.getDescendantsOfKind(SyntaxKind.JsxOpeningElement), ...parsed.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)].sort((a, b) => a.getStart() - b.getStart());
  const mutations: Mutation[] = [];
  for (const node of nodes) {
    const tagName = node.getTagNameNode().getText();
    if (!/^[a-z][a-z0-9]*$/.test(tagName) || node.getAttributes().some(Node.isJsxSpreadAttribute)) continue;
    const before = node.getText(), start = node.getStart(), end = node.getEnd();
    const position = parsed.getLineAndColumnAtPos(start);
    const add = (operator: Operator, after: string, referenceValue: string | null = null) => {
      if (before === after) return;
      const originalStart = start + bomOffset;
      mutations.push(MutationSchema.parse({ id: hash(`${file}\0${originalStart}\0${operator}\0${hash(source)}`), sourceHash: hash(source), file, component: componentIdentity(node, file), operator, ruleId: rules[operator], source: { file, line: position.line, column: position.column + (position.line === 1 ? bomOffset : 0) }, start: originalStart, end: end + bomOffset, before, after, tagName, referenceValue, literalId: literal(node, "id") }));
    };
    const removeAttribute = (name: string, operator: Operator) => {
      const value = literal(node, name), attribute = node.getAttribute(name);
      if (!value?.trim() || !attribute) return;
      const offset = attribute.getStart() - start;
      add(operator, before.slice(0, offset) + before.slice(attribute.getEnd() - start), value);
    };
    const append = (operator: Operator, attributes: string) => {
      const offset = before.lastIndexOf(Node.isJsxSelfClosingElement(node) ? "/>" : ">");
      if (offset < 0) return;
      add(operator, before.slice(0, offset) + attributes + before.slice(offset));
    };
    if (tagName === "img") removeAttribute("alt", "remove-alt");
    if (tagName === "button") removeAttribute("aria-label", "remove-button-name");
    if (tagName === "a" && node.getAttribute("href")) removeAttribute("aria-label", "remove-link-name");
    if (tagName === "html") removeAttribute("lang", "remove-lang");
    if (tagName === "label") {
      const value = literal(node, "htmlFor"), attribute = node.getAttribute("htmlFor");
      if (value && attribute && nodes.some(item => literal(item, "id") === value && ["input", "select", "textarea"].includes(item.getTagNameNode().getText()))) {
        const offset = attribute.getStart() - start;
        add("break-label", before.slice(0, offset) + 'htmlFor="accesswright-unmatched-label"' + before.slice(attribute.getEnd() - start), value);
      }
    }
    if (["button", "a", "input", "select", "textarea"].includes(tagName) && !node.getAttribute("aria-bogus")) append("invalid-aria", ' aria-bogus="accesswright-seeded"');
    if (["button", "a", "input", "select", "textarea"].includes(tagName) && !node.getAttribute("tabIndex")) append("positive-tabindex", " tabIndex={5}");
    const parent = node.getParent();
    if (["p", "span"].includes(tagName) && !node.getAttribute("style") && Node.isJsxElement(parent) && parent.getJsxChildren().some(child => Node.isJsxText(child) && child.getText().trim()) && parent.getJsxChildren().every(Node.isJsxText)) {
      append("low-contrast", ' style={{ color: "#cccccc", backgroundColor: "#ffffff" }}');
    }
  }
  return mutations;
}
function ordered(input: readonly Mutation[]): Mutation[] {
  const mutations = input.map(item => MutationSchema.parse(item)).sort((a, b) => a.start - b.start);
  if (new Set(mutations.map(item => item.id)).size !== mutations.length) throw new Error("Duplicate mutation");
  if (new Set(mutations.map(item => item.file)).size > 1) throw new Error("A source mutation batch must use one file");
  for (let index = 0; index < mutations.length; index += 1) {
    const current = mutations[index], previous = mutations[index - 1];
    if (!current || current.end - current.start !== current.before.length || (previous && previous.end > current.start)) throw new Error("Overlapping or invalid mutation spans");
  }
  return mutations;
}
export function applyMutations(source: string, input: readonly Mutation[]): string {
  const mutations = ordered(input);
  if (mutations.some(item => item.sourceHash !== hash(source) || source.slice(item.start, item.end) !== item.before)) throw new Error("Source hash or exact mutation span changed");
  let changed = source;
  for (const item of mutations.reverse()) changed = changed.slice(0, item.start) + item.after + changed.slice(item.end);
  return changed;
}
export function reverseMutations(source: string, input: readonly Mutation[]): string {
  const mutations = ordered(input);
  let delta = 0;
  const shifted = mutations.map(item => { const start = item.start + delta; delta += item.after.length - item.before.length; return { ...item, shiftedStart: start }; });
  let original = source;
  for (const item of shifted.reverse()) {
    if (original.slice(item.shiftedStart, item.shiftedStart + item.after.length) !== item.after) throw new Error("Mutated source changed before reversal");
    original = original.slice(0, item.shiftedStart) + item.before + original.slice(item.shiftedStart + item.after.length);
  }
  if (mutations.some(item => item.sourceHash !== hash(original))) throw new Error("Reversed source hash does not match the frozen original");
  return original;
}
export function selectDisjointMutations(input: readonly Mutation[], seed: number, maximum: number): Mutation[] {
  if (!Number.isSafeInteger(seed) || seed < 0 || !Number.isSafeInteger(maximum) || maximum < 0) throw new Error("Invalid evaluation seed or case limit");
  const used = new Set<string>();
  const sorted = [...input].sort((a, b) => hash(`${seed}:${a.id}`).localeCompare(hash(`${seed}:${b.id}`)));
  const result: Mutation[] = [];
  for (const item of sorted) if (result.length < maximum && !used.has(item.component)) { used.add(item.component); result.push(item); }
  return result;
}
