import { detectPackageManager } from "./detect.js";
import { PackageManifestSchema } from "./production-checks.js";

export const toolingRoot = "/tmp/accesswright-tools";
export const installedToolingRoot = "/workspace/node_modules/.accesswright-tools";
export const instrumentationPackagePath = `${installedToolingRoot}/node_modules/code-inspector-plugin`;
export const pinnedPnpmVersion = "12.9.1";

/** Literal argv only. Bootstrap tooling outside the application's locked dependency tree. */
export function dependencyInstallPlan(files: readonly string[], input: unknown) {
  const manifest = PackageManifestSchema.parse(input);
  const manager = detectPackageManager(files) ?? "npm";
  if (manager !== "npm" && manager !== "pnpm") throw new Error(`The persistent runner does not support ${manager} lockfiles`);
  let pnpmVersion = pinnedPnpmVersion;
  if (manager === "pnpm" && manifest.packageManager !== undefined) {
    const match = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha(?:224|256|384|512)\.[a-fA-F0-9]+)?$/.exec(manifest.packageManager);
    if (!match?.[1]) throw new Error("A pnpm repository must specify an exact pnpm package-manager version");
    pnpmVersion = match[1];
  }
  const tooling = ["npm", "install", "--prefix", toolingRoot, "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", "code-inspector-plugin@2.0.9", ...(manager === "pnpm" ? [`pnpm@${pnpmVersion}`] : [])];
  const target = manager === "pnpm"
    // Some pinned pnpm releases retain a shebang-less POSIX bootstrap when install scripts are disabled.
    // The constant shell program preserves literal argv and supports that stub as well as a native executable.
    ? ["sh", "-c", 'exec "$@"', "accesswright-package-manager", `${toolingRoot}/node_modules/.bin/pnpm`, "install", "--frozen-lockfile", "--ignore-scripts", "--config.manage-package-manager-versions=false", "--config.package-manager-strict=false"]
    : ["npm", files.includes("package-lock.json") || files.includes("npm-shrinkwrap.json") ? "ci" : "install", "--ignore-scripts", "--no-audit", "--no-fund"];
  return { manager, tooling, target, pnpmVersion: manager === "pnpm" ? pnpmVersion : null };
}
