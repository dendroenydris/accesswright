import { expect, it } from "vitest";
import { dependencyInstallPlan, instrumentationPackagePath } from "../../src/runner/install-plan.js";

it("starts a shebang-less pnpm bootstrap through a literal POSIX argv boundary", () => {
  const plan = dependencyInstallPlan(["pnpm-lock.yaml"], { packageManager: "pnpm@12.3.4", dependencies: { next: "16.3.8" } });
  expect(plan.target.slice(0, 5)).toEqual(["sh", "-c", 'exec "$@"', "accesswright-package-manager", "/tmp/accesswright-tools/node_modules/.bin/pnpm"]);
  expect(plan.target.slice(5)).toEqual(["install", "--frozen-lockfile", "--ignore-scripts", "--config.manage-package-manager-versions=false", "--config.package-manager-strict=false"]);
});

it("installs tooling separately and preserves the npm application's frozen dependency tree", () => {
  const plan = dependencyInstallPlan(["package-lock.json"], { dependencies: { next: "16.3.8" } });
  expect(plan.target).toEqual(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  expect(plan.tooling).toContain("--prefix");
  expect(plan.tooling).toContain("/tmp/accesswright-tools");
  expect(plan.tooling).toContain("code-inspector-plugin@2.0.9");
  expect(instrumentationPackagePath).toBe("/workspace/node_modules/.accesswright-tools/node_modules/code-inspector-plugin");
});
it("honors an exact pnpm version and frozen lockfile with lifecycle scripts disabled", () => {
  const plan = dependencyInstallPlan(["pnpm-lock.yaml"], { packageManager: "pnpm@10.18.2", dependencies: { next: "16.3.8" } });
  expect(plan.tooling).toContain("pnpm@10.18.2");
  expect(plan.target[4]).toBe("/tmp/accesswright-tools/node_modules/.bin/pnpm");
  expect(plan.target).toContain("--frozen-lockfile");
  expect(plan.target).toContain("--ignore-scripts");
  expect(plan.target).toContain("--config.manage-package-manager-versions=false");
});
it("rejects ambiguous or executable package-manager specifications instead of substituting npm", () => {
  expect(() => dependencyInstallPlan(["yarn.lock"], {})).toThrow(/support/i);
  expect(() => dependencyInstallPlan(["pnpm-lock.yaml", "package-lock.json"], {})).toThrow(/Multiple/);
  expect(() => dependencyInstallPlan(["pnpm-lock.yaml"], { packageManager: "pnpm@latest" })).toThrow(/exact/i);
  expect(() => dependencyInstallPlan(["pnpm-lock.yaml"], { packageManager: "https://evil.invalid/pkg.tgz" })).toThrow();
  expect(() => dependencyInstallPlan(["pnpm-lock.yaml"], { packageManager: "yarn@4.0.0" })).toThrow();
});
