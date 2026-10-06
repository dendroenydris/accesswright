import { describe, expect, it } from "vitest";

import { verifyFinal } from "../../src/verifier/final.js";
import type { FinalCheckSnapshot } from "../../src/verifier/final.js";

const clean: FinalCheckSnapshot = {
  build: [],
  typecheck: [],
  lint: [],
  tests: [],
  violations: [],
};

describe("verifyFinal", () => {
  it("ignores failures already present in the baseline", async () => {
    const baseline: FinalCheckSnapshot = {
      ...clean,
      lint: ["legacy-warning"],
      tests: ["legacy-test"],
    };

    const result = await verifyFinal({
      baseline,
      fixIds: ["fix-a"],
      runChecks: () => Promise.resolve(baseline),
      rerunTests: () => Promise.resolve(["legacy-test"]),
    });

    expect(result).toEqual({
      acceptedFixIds: ["fix-a"],
      droppedFixIds: [],
      failures: [],
    });
  });

  it("reruns a newly failing test once before accepting a flaky result", async () => {
    let checkCalls = 0;
    const result = await verifyFinal({
      baseline: clean,
      fixIds: ["fix-a"],
      runChecks: () => {
        checkCalls += 1;
        return Promise.resolve({ ...clean, tests: ["flaky-test"] });
      },
      rerunTests: (_fixIds, tests) => {
        expect(tests).toEqual(["flaky-test"]);
        return Promise.resolve([]);
      },
    });

    expect(checkCalls).toBe(1);
    expect(result.droppedFixIds).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("bisects and drops a deliberately breaking fix, then rechecks the remainder", async () => {
    const runs: string[][] = [];
    const runChecks = (fixIds: readonly string[]): Promise<FinalCheckSnapshot> => {
      runs.push([...fixIds]);
      return Promise.resolve(
        fixIds.includes("fix-bad")
          ? { ...clean, build: ["next-build"] }
          : clean,
      );
    };

    const result = await verifyFinal({
      baseline: clean,
      fixIds: ["fix-a", "fix-bad", "fix-c"],
      runChecks,
      rerunTests: () => Promise.resolve([]),
    });

    expect(result.acceptedFixIds).toEqual(["fix-a", "fix-c"]);
    expect(result.droppedFixIds).toEqual(["fix-bad"]);
    expect(result.failures).toEqual([]);
    expect(runs.some((ids) => ids.length < 3)).toBe(true);
    expect(runs.at(-1)).toEqual(["fix-a", "fix-c"]);
  });

  it("reports an interaction failure when no single half reproduces it", async () => {
    const runChecks = (fixIds: readonly string[]): Promise<FinalCheckSnapshot> =>
      Promise.resolve(
        fixIds.includes("fix-a") && fixIds.includes("fix-b")
          ? { ...clean, typecheck: ["interaction"] }
          : clean,
      );

    const result = await verifyFinal({
      baseline: clean,
      fixIds: ["fix-a", "fix-b"],
      runChecks,
      rerunTests: () => Promise.resolve([]),
    });

    expect(result.acceptedFixIds).toEqual(["fix-a", "fix-b"]);
    expect(result.droppedFixIds).toEqual([]);
    expect(result.failures).toEqual([
      { check: "typecheck", id: "interaction" },
    ]);
  });
});
