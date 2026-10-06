import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const nextConfigPattern = /^next\.config\.(?:js|mjs|cjs|ts|mts|cts)$/;
export const sourceMappingPluginSpecifier = "code-inspector-plugin";
export const sourceMappingPluginInstallSpec = "code-inspector-plugin@2.0.9";

export async function instrumentNextWorkspace(
  root: string,
  pluginModuleUrl = sourceMappingPluginSpecifier,
): Promise<string> {
  const entries = await readdir(root);
  const existingConfig = entries.find((entry) => nextConfigPattern.test(entry));
  if (existingConfig !== undefined) {
    throw new Error(
      `Existing Next config requires merge support before source-mapping injection: ${existingConfig}`,
    );
  }

  const path = join(root, "next.config.mjs");
  const config = `import { codeInspectorPlugin } from ${JSON.stringify(pluginModuleUrl)};\n\nconst nextConfig = {\n  turbopack: {\n    rules: codeInspectorPlugin({ bundler: "turbopack" }),\n  },\n};\n\nexport default nextConfig;\n`;
  await writeFile(path, config, "utf8");
  return path;
}
