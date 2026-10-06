export type RouterKind = "app" | "pages" | "mixed" | "unknown";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

function hasTopLevelDirectory(files: readonly string[], directory: string): boolean {
  const prefix = `${directory}/`;
  const srcPrefix = `src/${directory}/`;
  return files.some((file) => file.startsWith(prefix) || file.startsWith(srcPrefix));
}

export function detectRouterKind(files: readonly string[]): RouterKind {
  const hasApp = hasTopLevelDirectory(files, "app");
  const hasPages = hasTopLevelDirectory(files, "pages");

  if (hasApp && hasPages) return "mixed";
  if (hasApp) return "app";
  if (hasPages) return "pages";
  return "unknown";
}

const packageManagerLockfiles: ReadonlyArray<{
  manager: PackageManager;
  names: readonly string[];
}> = [
  { manager: "npm", names: ["package-lock.json", "npm-shrinkwrap.json"] },
  { manager: "pnpm", names: ["pnpm-lock.yaml"] },
  { manager: "yarn", names: ["yarn.lock"] },
  { manager: "bun", names: ["bun.lock", "bun.lockb"] },
];

export function detectPackageManager(files: readonly string[]): PackageManager | null {
  const topLevel = new Set(files.filter((file) => !file.includes("/")));
  const matches = packageManagerLockfiles.filter(({ names }) =>
    names.some((name) => topLevel.has(name)),
  );

  if (matches.length > 1) {
    throw new Error(
      `Multiple package-manager lockfiles detected: ${matches.map(({ manager }) => manager).join(", ")}`,
    );
  }

  return matches[0]?.manager ?? null;
}
