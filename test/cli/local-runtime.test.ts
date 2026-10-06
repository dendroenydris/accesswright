import { describe, expect, it } from "vitest";

import {
  ariaSnapshotFailures,
  resolveSourcePath,
} from "../../src/core/local-runtime.js";

describe("resolveSourcePath", () => {
  it("resolves a project-relative source path inside the repository", () => {
    expect(resolveSourcePath("/tmp/repo", "app/page.tsx")).toBe(
      "/tmp/repo/app/page.tsx",
    );
  });

  it.each(["../secret", "/etc/passwd"])(
    "rejects a source path that escapes the repository: %s",
    (sourcePath) => {
      expect(() => resolveSourcePath("/tmp/repo", sourcePath)).toThrow(
        /repository/i,
      );
    },
  );
});

describe("ariaSnapshotFailures", () => {
  it("returns no probe failure when route snapshots are unchanged", () => {
    const baseline = new Map([["/", "- main: Text"]]);
    const candidate = new Map([["/", "- main: Text"]]);
    expect(ariaSnapshotFailures(baseline, candidate)).toEqual([]);
  });

  it("fails closed when a route snapshot changes or disappears", () => {
    const baseline = new Map([
      ["/", "- main: Text"],
      ["/about", "- main: About"],
    ]);
    const candidate = new Map([["/", "- main: Changed"]]);

    expect(ariaSnapshotFailures(baseline, candidate)).toEqual([
      "aria-tree:/",
      "aria-tree:/about",
    ]);
  });

  it("fails closed when a new scanned route appears in the candidate", () => {
    const baseline = new Map([["/", "- main: Text"]]);
    const candidate = new Map([
      ["/", "- main: Text"],
      ["/new", "- main: New"],
    ]);

    expect(ariaSnapshotFailures(baseline, candidate)).toEqual([
      "aria-tree:/new",
    ]);
  });
});
