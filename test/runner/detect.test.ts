import { describe, expect, it } from "vitest";

import { detectPackageManager, detectRouterKind } from "../../src/runner/detect.js";

describe("detectRouterKind", () => {
  it("detects App Router from an app directory", () => {
    expect(detectRouterKind(["app/page.tsx", "app/layout.tsx"])).toBe("app");
  });

  it("detects Pages Router from a pages directory", () => {
    expect(detectRouterKind(["pages/index.tsx", "pages/_app.tsx"])).toBe("pages");
  });

  it("preserves mixed-router repositories instead of silently preferring one", () => {
    expect(detectRouterKind(["app/page.tsx", "pages/legacy.tsx"])).toBe("mixed");
  });

  it("returns unknown when neither router is present", () => {
    expect(detectRouterKind(["src/components/Button.tsx"])).toBe("unknown");
  });
});

describe("detectPackageManager", () => {
  it.each([
    [["package-lock.json"], "npm"],
    [["pnpm-lock.yaml"], "pnpm"],
    [["yarn.lock"], "yarn"],
    [["bun.lock"], "bun"],
    [["bun.lockb"], "bun"],
  ] as const)("detects %s", (files, expected) => {
    expect(detectPackageManager([...files])).toBe(expected);
  });

  it("returns null without a recognized lockfile", () => {
    expect(detectPackageManager(["package.json"])).toBeNull();
  });

  it("rejects ambiguous multiple lockfiles", () => {
    expect(() => detectPackageManager(["package-lock.json", "pnpm-lock.yaml"])).toThrow(
      /multiple package-manager lockfiles/i,
    );
  });
});
