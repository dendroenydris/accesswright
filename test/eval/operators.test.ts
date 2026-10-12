import { expect, it } from "vitest";
import { generateMutations, applyMutations, reverseMutations, selectDisjointMutations } from "../../src/eval/operators.js";

const file = "app/page.tsx";
const source = `export default function Page() { return <section><img id="portrait" src="/portrait.png" alt="Portrait of Ada" /><label htmlFor="email">Email</label><input id="email" /><button aria-label="Save changes"><svg aria-hidden="true" /></button><a href="/help" aria-label="Help"><svg aria-hidden="true" /></a><p>Readable information</p></section>; }\nexport function Root() { return <html lang="en"><body /></html>; }\n`;
it("generates all eight reversible P0 mutation types from real JSX syntax", () => {
  const mutations = generateMutations(file, source);
  expect(new Set(mutations.map(item => item.operator))).toEqual(new Set(["remove-alt", "break-label", "remove-button-name", "remove-link-name", "low-contrast", "invalid-aria", "remove-lang", "positive-tabindex"]));
  for (const mutation of mutations) {
    const changed = applyMutations(source, [mutation]);
    expect(changed).not.toBe(source);
    expect(reverseMutations(changed, [mutation])).toBe(source);
    expect(mutation.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  }
});
it.each(["\n", "\r\n"])("preserves original BOM-prefixed source offsets with %j line endings", newline => {
  const original = "\uFEFF" + source.replaceAll("\n", newline);
  const mutations = generateMutations(file, original);
  expect(mutations.length).toBeGreaterThan(0);
  for (const mutation of mutations) {
    expect(original.slice(mutation.start, mutation.end)).toBe(mutation.before);
    const precedingLines = original.slice(0, mutation.start).split("\n");
    expect(mutation.source).toMatchObject({ line: precedingLines.length, column: (precedingLines.at(-1)?.length ?? 0) + 1 });
    const changed = applyMutations(original, [mutation]);
    expect(changed.startsWith("\uFEFF")).toBe(true);
    expect(reverseMutations(changed, [mutation])).toBe(original);
  }
});
it("does not mistake comments, string literals or computed attributes for editable ground truth", () => {
  const text = 'const fake = "<img alt=label />"; /* <button aria-label="Save"/> */ export const Picture = () => <img alt={user.name} src="/x" />;';
  expect(generateMutations(file, text).filter(item => ["remove-alt", "remove-button-name"].includes(item.operator))).toEqual([]);
});
it("refuses stale source or overlapping mutations rather than silently changing the benchmark", () => {
  const mutations = generateMutations(file, source);
  const first = mutations[0];
  if (!first) throw new Error("Missing test mutation");
  expect(() => applyMutations(source + "// changed", [first])).toThrow(/source|hash/i);
  expect(() => applyMutations(source, [first, first])).toThrow(/overlap|duplicate/i);
});
it("selects reproducible disjoint component cases before any repair result exists", () => {
  const mutations = generateMutations(file, source);
  const selected = selectDisjointMutations(mutations, 123, 20);
  expect(selectDisjointMutations(mutations, 123, 20)).toEqual(selected);
  expect(new Set(selected.map(item => item.component)).size).toBe(selected.length);
  expect(selected.length).toBeGreaterThan(0);
});
