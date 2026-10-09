import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { runEvaluation } from "../../src/eval/runner.js";
import { EvalProtocolSchema } from "../../src/eval/protocol.js";
import { generateMutations } from "../../src/eval/operators.js";
import { freezeRenderedCases } from "../../src/eval/cases.js";
import { BrowserObservationSchema } from "../../src/scanner/observations.js";
import { evalReferenceFileName } from "../../src/eval/resume.js";

it("resumes a partial frozen evaluation without repeating already persisted failed preparation cells", async () => {
  const root = await mkdtemp(join(process.env.ACCESSWRIGHT_TMP_ROOT ?? tmpdir(), "aw-resume-real-"));
  try {
    const source = join(root, "fixture");
    const output = join(root, "output");
    await mkdir(source);
    await writeFile(join(source, "README.md"), "fixture without package manifest\n");
    const protocol = EvalProtocolSchema.parse({
      version: 1,
      corpus: "controlled-fixtures",
      frozenAt: "2026-10-08T00:00:00.000Z",
      selection: "fixed original, no source retries",
      repositories: [{ repository: "owner/frozen", sha: "a".repeat(40), license: "MIT", split: "dev" }],
      model: { provider: "openai", id: "fixture-only" },
      operators: ["invalid-aria"],
      systems: ["deterministic"],
      seeds: { dev: [1], test: [1] },
      maxCasesPerRepository: 1,
      targetTestCases: 300,
    });
    const options = {
      frozen: { protocol, digest: createHash("sha256").update(JSON.stringify(protocol)).digest("hex") },
      runtimeRoot: process.cwd(),
      tempRoot: join(root, "temp"),
      outputDir: output,
      cacheRoot: join(root, "cache"),
      fixtureRoots: { "owner/frozen": source },
      split: "dev" as const,
      systems: ["deterministic" as const],
      seeds: [1],
      caseLimit: 1,
    };
    const first = await runEvaluation(options);
    expect(first.cells).toHaveLength(1);
    expect(first.cells[0]?.status).toBe("blocked");
    await unlink(join(output, "summary.json"));
    await unlink(join(output, "report.md"));
    const resumed = await runEvaluation({ ...options, resume: true });
    expect(resumed.cells).toHaveLength(1);
    expect(resumed.cells[0]).toEqual(first.cells[0]);
    expect(resumed.summary.groups[0]?.blockedCells).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reuses validated original references on resumed incomplete selection, while still verifying candidate runs independently", async () => {
  const root = await mkdtemp(join(process.env.ACCESSWRIGHT_TMP_ROOT ?? tmpdir(), "aw-reference-resume-e2e-"));
  try {
    const source = join(root, "fixture");
    const output = join(root, "output");
    await mkdir(join(source, "app"), { recursive: true });
    const pageSource = 'export default function Page(){ return <button id="save" aria-label="Save changes">Save</button>; }\n';
    await writeFile(join(source, "app/page.tsx"), pageSource);
    const protocol = EvalProtocolSchema.parse({
      version: 1, corpus: "controlled-fixtures", frozenAt: "2026-10-08T00:00:00.000Z",
      selection: "original reference from controlled test, never benchmark scoring",
      repositories: [{ repository: "owner/frozen", sha: "a".repeat(40), license: "MIT", split: "dev" }],
      model: { provider: "openai", id: "fixture-only" }, operators: ["remove-button-name", "invalid-aria"],
      systems: ["deterministic"], seeds: { dev: [1], test: [1] },
      maxCasesPerRepository: 2, targetTestCases: 300,
    });
    const options = {
      frozen: { protocol, digest: createHash("sha256").update(JSON.stringify(protocol)).digest("hex") },
      runtimeRoot: process.cwd(), tempRoot: join(root, "temp"), outputDir: output,
      cacheRoot: join(root, "cache"), fixtureRoots: { "owner/frozen": source },
      split: "dev" as const, systems: ["deterministic" as const], seeds: [1], caseLimit: 2,
    };
    const first = await runEvaluation(options);
    expect(first.cells).toHaveLength(1);
    expect(first.cells[0]?.status).toBe("blocked");
    await unlink(join(output, "summary.json"));
    await unlink(join(output, "report.md"));
    const mut = generateMutations("app/page.tsx", pageSource)
      .filter(item => ["remove-button-name", "invalid-aria"].includes(item.operator));
    expect(mut).toHaveLength(2);
    const page = BrowserObservationSchema.parse({
      route: "/", condition: "desktop-light",
      violations: [], incomplete: [], probeFailures: [], probeUnavailable: [],
      aria: [{ id: "/|desktop-light|#save", role: "button", name: "Save changes", text: "Save", interactive: true }],
      ariaTree: "", contexts: [], screenshot: "fixture.png", darkMediaDetected: false,
      sourceFiles: ["app/page.tsx"], sourceIndex: [{
        nodeId: "/|desktop-light|#save", target: ["#save"], source: mut[0]?.source,
        tagName: "button", mapping: "direct",
      }],
    });
    const rendered = freezeRenderedCases(mut, [page]);
    expect(rendered.eligible).toHaveLength(2);
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as { implementationDigest: string };
    await writeFile(join(output, evalReferenceFileName("owner/frozen")), JSON.stringify({
      repository: protocol.repositories[0], rendered, implementationDigest: manifest.implementationDigest,
    }));
    const phases: string[] = [];
    const resumed = await runEvaluation({ ...options, resume: true, onProgress: event => {
      if (typeof event.phase === "string") phases.push(event.phase);
    } });
    expect(phases).toContain("reuse-original-reference");
    expect(phases).not.toContain("prepare-original");
    expect(resumed.cells).toHaveLength(2);
    expect(resumed.cells.every(cell => cell.status === "blocked")).toBe(true);
    expect(resumed.cells[0]).toEqual(first.cells[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
