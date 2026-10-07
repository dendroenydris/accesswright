import { Project, SyntaxKind } from "ts-morph";
import { z } from "zod";

const objectSchema = z.record(z.string(), z.unknown());
const ruleSchema = z.object({ loaders: z.array(z.unknown()).optional(), as: z.string().optional() }).passthrough();
export interface MappingPlugins { turbopack: unknown; webpack: unknown }

function mergeRules(original: unknown, injected: unknown): Record<string, unknown> {
  const rules = { ...objectSchema.parse(original ?? {}) };
  for (const [pattern, addition] of Object.entries(objectSchema.parse(injected))) {
    const existing = rules[pattern];
    if (existing === undefined) { rules[pattern] = addition; continue; }
    if (existing === false || addition === false) throw new Error(`Instrumentation rule conflict: ${pattern}`);
    if (Array.isArray(existing) || Array.isArray(addition)) {
      const before: unknown[] = Array.isArray(existing) ? z.array(z.unknown()).parse(existing) : [existing];
      const after: unknown[] = Array.isArray(addition) ? z.array(z.unknown()).parse(addition) : [addition];
      rules[pattern] = [...before, ...after];
      continue;
    }
    const before = ruleSchema.parse(existing), after = ruleSchema.parse(addition);
    if (before.as !== undefined && after.as !== undefined && before.as !== after.as) {
      throw new Error(`Instrumentation output-type conflict: ${pattern}`);
    }
    rules[pattern] = { ...before, ...after, loaders: [...(before.loaders ?? []), ...(after.loaders ?? [])] };
  }
  return rules;
}

/** Called only from a generated sandbox configuration, never from the target on the host. */
export function withSourceMapping(original: unknown, plugins: MappingPlugins, nextVersion: string): unknown {
  const version = /^(\d+)\.(\d+)\./.exec(nextVersion);
  if (!version) throw new Error("An installed Next.js version is required for instrumentation");
  const major = Number(version[1]), minor = Number(version[2]);
  const merge = (input: unknown): Record<string, unknown> => {
    const config = objectSchema.parse(input ?? {});
    const existingWebpack = config.webpack;
    const webpack = function (this: unknown, ...args: unknown[]) {
      const result: unknown = typeof existingWebpack === "function" ? Reflect.apply(existingWebpack, this, args) : args[0];
      const output = objectSchema.parse(result);
      const existing = z.array(z.unknown()).parse(output.plugins ?? []);
      return { ...output, plugins: [...existing, plugins.webpack] };
    };
    if (major < 15) return { ...config, webpack };
    if (major === 15 && minor < 3) {
      const experimental = objectSchema.parse(config.experimental ?? {});
      const turbo = objectSchema.parse(experimental.turbo ?? {});
      return { ...config, webpack, experimental: { ...experimental, turbo: { ...turbo, rules: mergeRules(turbo.rules, plugins.turbopack) } } };
    }
    const turbopack = objectSchema.parse(config.turbopack ?? {});
    return { ...config, webpack, turbopack: { ...turbopack, rules: mergeRules(turbopack.rules, plugins.turbopack) } };
  };
  if (typeof original === "function") {
    return function (this: unknown, ...args: unknown[]) {
      const result: unknown = Reflect.apply(original, this, args);
      return Promise.resolve(result).then(merge);
    };
  }
  if (original instanceof Promise) return original.then(merge);
  return merge(original);
}

/** Changes a sandbox copy's export expression, preserving relative imports and the original filename. */
export function instrumentConfigSource(source: string, file: string, esm: boolean, nextVersion: string): string {
  if (!/^next\.config\.(?:js|mjs|cjs|ts|mts|cts)$/.test(file)) throw new Error("Unsupported Next configuration filename");
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const parsed = project.createSourceFile(file, source);
  let suffix = 0;
  while (source.includes(`__aw_mapping_${suffix}`) || source.includes(`__aw_inspector_${suffix}`)) suffix += 1;
  const wrapper = `__aw_mapping_${suffix}`, inspector = `__aw_inspector_${suffix}`;
  const wrap = (expression: string) => `${wrapper}((${expression}), { turbopack: ${inspector}({ bundler: "turbopack" }), webpack: ${inspector}({ bundler: "webpack" }) }, ${JSON.stringify(nextVersion)})`;
  if (esm) {
    const assignments = parsed.getExportAssignments().filter(item => !item.isExportEquals());
    const declarations = parsed.getFunctions().filter(item => item.isDefaultExport());
    if (assignments.length === 1 && declarations.length === 0) {
      const assignment = assignments[0];
      if (!assignment) throw new Error("Missing default export");
      assignment.setExpression(wrap(assignment.getExpression().getText()));
    } else if (assignments.length === 0 && declarations.length === 1) {
      const declaration = declarations[0];
      if (!declaration) throw new Error("Missing default function export");
      if (!declaration.getName()) declaration.set({ name: `__aw_original_${suffix}` });
      const name = declaration.getNameOrThrow();
      declaration.setIsDefaultExport(false);
      parsed.addExportAssignment({ isExportEquals: false, expression: wrap(name) });
    } else throw new Error("Configuration needs one identifiable default export");
    parsed.insertStatements(0, `import { withSourceMapping as ${wrapper} } from "/accesswright/dist/src/runner/config-merge.js";\nimport { codeInspectorPlugin as ${inspector} } from "code-inspector-plugin";`);
  } else {
    const exports = parsed.getDescendantsOfKind(SyntaxKind.BinaryExpression).filter(expression =>
      expression.getOperatorToken().getKind() === SyntaxKind.EqualsToken && expression.getLeft().getText() === "module.exports",
    );
    if (exports.length !== 1) throw new Error("Configuration needs one identifiable module.exports assignment");
    const exported = exports[0];
    if (!exported) throw new Error("Missing CommonJS export");
    exported.getRight().replaceWithText(wrap(exported.getRight().getText()));
    parsed.insertStatements(0, `const { withSourceMapping: ${wrapper} } = require("/accesswright/dist/src/runner/config-merge.js");\nconst { codeInspectorPlugin: ${inspector} } = require("code-inspector-plugin");`);
  }
  return parsed.getFullText();
}
