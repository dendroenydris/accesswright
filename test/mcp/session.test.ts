import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { McpAgentVerifier } from "../../src/mcp/session.js";
import type { McpRepairRuntime } from "../../src/mcp/session.js";
import { copyTargetSnapshot } from "../../src/sandbox/source-boundary.js";
import type { BrowserObservation } from "../../src/scanner/observations.js";
import type { Violation } from "../../src/types/schemas.js";

const roots: string[] = [];
const violation: Violation = {
  ruleId: "aria-valid-attr", impact: "moderate", route: "/", target: ["#save"],
  html: '<button id="save" aria-bogus="wrong">Save</button>',
  failureSummary: "Invalid aria attribute", condition: "desktop-light",
  source: { file: "app/page.tsx", line: 1, column: 1 },
};
function observation(fixed: boolean, hidden = false): BrowserObservation {
  return {
    route: "/", condition: "desktop-light", checkerVersion: "fixture",
    violations: fixed ? [] : [violation], incomplete: [], sourceIndex: [],
    aria: hidden ? [] : [{ id: "/|desktop-light|#save", role: "button", name: "Save", text: "Save", interactive: true }],
    ariaTree: "", contexts: [], sourceFiles: ["app/page.tsx"], probeFailures: [],
    probeUnavailable: [], screenshot: "fixture.png", darkMediaDetected: false,
  };
}
async function harness(fixed = true, hidden = false) {
  const root = await mkdtemp(join(tmpdir(), "aw-mcp-session-"));
  roots.push(root);
  const repoPath = join(root, "repo"), sourceRoot = join(root, "snapshot");
  await mkdir(join(repoPath, "app"), { recursive: true });
  await writeFile(join(repoPath, "app/page.tsx"), 'export default () => <button id="save" aria-bogus="wrong">Save</button>;\n');
  await writeFile(join(repoPath, "package.json"), '{"name":"fixture"}\n');
  await copyTargetSnapshot(repoPath, sourceRoot);
  let applied = 0, reverted = 0, recorded = 0, closed = 0;
  let finalHook: (() => Promise<void>) | null = null;
  const runtime: McpRepairRuntime = {
    sourceRoot, routes: ["/"], observations: [observation(false)],
    baselineChecks: [],
    finalChecks: ["build", "typecheck", "lint", "tests"].map(check => ({
      check: check as "build" | "typecheck" | "lint" | "tests",
      argv: [], available: true, status: "passed" as const, durationMs: 1,
      exitCode: 0, failureIds: [],
    })),
    affectedRoutes: () => ["/"],
    applyPatch: patch => { applied += 1; return Promise.resolve(patch); },
    revertPatch: () => { reverted += 1; return Promise.resolve(); },
    scan: () => Promise.resolve([observation(fixed, hidden)]),
    updateObservations: () => {},
    record: () => { recorded += 1; return Promise.resolve(); },
    verifyFinal: async () => {
      if (finalHook) await finalHook();
      return {
        acceptedFixIds: recorded ? ["codemod:4.1.2:aria-valid-attr:app/page.tsx:1:1"] : [],
        droppedFixIds: [], failures: [],
      };
    },
    close: () => { closed += 1; return Promise.resolve(); },
  };
  const verifier = new McpAgentVerifier(
    { repoPath, tempRoot: root, runtimeRoot: root },
    { prepare: () => Promise.resolve(runtime) },
  );
  return { repoPath, verifier, setFinalHook(fn: () => Promise<void>) { finalHook = fn; }, get applied() { return applied; }, get reverted() { return reverted; }, get recorded() { return recorded; }, get closed() { return closed; } };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("MCP scan captures task identities, then verify uses the real per-patch and final gates without writing host code", async () => {
  const h = await harness();
  const scan = await h.verifier.scan();
  expect(scan.tasks).toHaveLength(1);
  const before = await readFile(join(h.repoPath, "app/page.tsx"), "utf8");
  const after = before.replace('aria-bogus="wrong"', 'aria-label="Save"');
  await writeFile(join(h.repoPath, "app/page.tsx"), after);
  const result = await h.verifier.verify(scan.tasks[0].id);
  expect(result).toMatchObject({ accepted: true, stage: "complete" });
  expect(h.applied).toBe(1);
  expect(h.recorded).toBe(1);
  expect(await readFile(join(h.repoPath, "app/page.tsx"), "utf8")).toBe(after);
  await h.verifier.close();
  expect(h.closed).toBe(1);
});

it("MCP verify rejects hidden meaningful controls even when axe target disappears", async () => {
  const h = await harness(true, true);
  const scan = await h.verifier.scan();
  const before = await readFile(join(h.repoPath, "app/page.tsx"), "utf8");
  await writeFile(join(h.repoPath, "app/page.tsx"), before.replace("<button", "<button hidden"));
  const result = await h.verifier.verify(scan.tasks[0].id);
  expect(result).toMatchObject({ accepted: false, stage: "per-patch", check: "aria-tree" });
  expect(h.reverted).toBe(1);
  expect(h.recorded).toBe(0);
  await h.verifier.close();
});

it("MCP verify never tests a subset while silently ignoring changed manifests", async () => {
  const h = await harness();
  const scan = await h.verifier.scan();
  await writeFile(join(h.repoPath, "package.json"), '{"name":"changed"}\n');
  await expect(h.verifier.verify(scan.tasks[0].id)).rejects.toThrow(/non-source/i);
  expect(h.applied).toBe(0);
  await h.verifier.close();
});

it("MCP fails closed if the developer edits source again during production verification", async () => {
  const h = await harness();
  const scan = await h.verifier.scan();
  const before = await readFile(join(h.repoPath, "app/page.tsx"), "utf8");
  const after = before.replace('aria-bogus="wrong"', 'aria-label="Save"');
  await writeFile(join(h.repoPath, "app/page.tsx"), after);
  h.setFinalHook(async () => {
    await writeFile(join(h.repoPath, "app/page.tsx"), after.replace("Save</button>", "Changed</button>"));
  });
  const result = await h.verifier.verify(scan.tasks[0].id);
  expect(result).toMatchObject({ accepted: false, stage: "source", check: "stale" });
  expect(h.closed).toBe(1);
});
