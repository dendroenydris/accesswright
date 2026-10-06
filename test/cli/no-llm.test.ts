import { describe, expect, it } from "vitest";

import { runNoLlmRepair } from "../../src/core/no-llm.js";
import type { NoLlmRuntime } from "../../src/core/no-llm.js";
import type {
  PageVerificationState,
} from "../../src/verifier/per-patch.js";
import type { Patch, Violation } from "../../src/types/schemas.js";

function violation(
  ruleId: string,
  source: Violation["source"],
): Violation {
  return {
    ruleId,
    impact: "critical",
    route: "/",
    target: ["#target"],
    html: "<div>fixture</div>",
    failureSummary: "fixture",
    source,
  };
}

class FakeRuntime implements NoLlmRuntime {
  readonly applied: Patch[] = [];
  private current: PageVerificationState;
  private readonly candidate: PageVerificationState;
  private readonly sources: Readonly<Record<string, string>>;

  constructor(
    current: PageVerificationState,
    candidate: PageVerificationState,
    sources: Readonly<Record<string, string>>,
  ) {
    this.current = current;
    this.candidate = candidate;
    this.sources = sources;
  }

  scan(): Promise<PageVerificationState> {
    return Promise.resolve(this.current);
  }

  readSource(path: string): Promise<string> {
    const source = this.sources[path];
    if (source === undefined) throw new Error(`missing source: ${path}`);
    return Promise.resolve(source);
  }

  scanCandidate(): Promise<PageVerificationState> {
    return Promise.resolve(this.candidate);
  }

  applyVerifiedPatch(patch: Patch): Promise<void> {
    this.applied.push(patch);
    this.current = this.candidate;
    return Promise.resolve();
  }
}

describe("runNoLlmRepair", () => {
  it("applies a verified deterministic codemod and stops after the rescan is clean", async () => {
    const item = violation(
      "aria-valid-attr",
      { file: "app/page.tsx", line: 2, column: 10 },
    );
    const runtime = new FakeRuntime(
      { violations: [item], aria: [], probeFailures: [] },
      { violations: [], aria: [], probeFailures: [] },
      {
        "app/page.tsx": `export default function Page() {
  return <div aria-bogus="x">Visible</div>;
}
`,
      },
    );

    const result = await runNoLlmRepair(runtime);

    expect(result).toMatchObject({
      fixed: 1,
      rejected: 0,
      needsHuman: 0,
      attempts: 1,
    });
    expect(runtime.applied).toHaveLength(1);
    expect(runtime.applied[0]?.changes[0]?.after).not.toContain("aria-bogus");
  });

  it("does not call a fixer for semantic work in no-LLM mode", async () => {
    const item = violation(
      "image-alt",
      { file: "app/page.tsx", line: 2, column: 3 },
    );
    const runtime = new FakeRuntime(
      { violations: [item], aria: [], probeFailures: [] },
      { violations: [], aria: [], probeFailures: [] },
      { "app/page.tsx": "export default () => <img />;\n" },
    );

    const result = await runNoLlmRepair(runtime);

    expect(result).toMatchObject({ fixed: 0, rejected: 0, needsHuman: 1 });
    expect(runtime.applied).toHaveLength(0);
  });

  it("does not apply a candidate rejected by the per-patch verifier", async () => {
    const item = violation(
      "aria-valid-attr",
      { file: "app/page.tsx", line: 2, column: 10 },
    );
    const introduced = violation(
      "button-name",
      { file: "app/page.tsx", line: 3, column: 3 },
    );
    const runtime = new FakeRuntime(
      { violations: [item], aria: [], probeFailures: [] },
      { violations: [introduced], aria: [], probeFailures: [] },
      {
        "app/page.tsx": `export default function Page() {
  return <div aria-bogus="x">Visible</div>;
}
`,
      },
    );

    const result = await runNoLlmRepair(runtime);

    expect(result).toMatchObject({ fixed: 0, rejected: 1 });
    expect(runtime.applied).toHaveLength(0);
  });

  it("applies an inline literal contrast fix through the optimizer route", async () => {
    const item = violation(
      "color-contrast",
      { file: "app/page.tsx", line: 3, column: 5 },
    );
    const runtime = new FakeRuntime(
      { violations: [item], aria: [], probeFailures: [] },
      { violations: [], aria: [], probeFailures: [] },
      {
        "app/page.tsx": `export default function Page() {
  return (
    <p style={{ color: "#aaa", backgroundColor: "#fff" }}>Low contrast</p>
  );
}
`,
      },
    );

    const result = await runNoLlmRepair(runtime);

    expect(result.fixed).toBe(1);
    expect(runtime.applied[0]?.changes[0]?.after).not.toContain('color: "#aaa"');
  });
});
