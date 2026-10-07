import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";
import { DockerRepairSession } from "../../src/runner/repair-session.js";
import { planFixTasks } from "../../src/planner/planner.js";
import { observationsToState } from "../../src/scanner/observations.js";
import { verifyPerPatch } from "../../src/verifier/per-patch.js";

it("drops a dev-only repair whose original target returns in the real production build", async () => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, "production-only-fixture-"));
  await createNextIntegrationFixture(root);
  const session = await DockerRepairSession.prepare({ repoPath: root, tempRoot, runtimeRoot: process.cwd(), retainEvidence: true, config: { offline: true, scan: { mobile: true } } });
  try {
    const task = planFixTasks(observationsToState(session.observations).violations).find(item => item.ruleId === "aria-valid-attr");
    if (!task?.source) throw new Error("Expected mapped invalid-ARIA target");
    const before = session.observations.filter(page => task.routes.includes(page.route));
    const patch = await session.applyPatch({ taskId: task.id, changes: [{ path: task.source.file, before: 'aria-bogus="invalid"', after: '{...(process.env.NODE_ENV === "production" ? { "aria-bogus": "invalid" } : {})}' }] });
    const after = await session.scan(task.routes, "dev-only-candidate");
    const verdict = verifyPerPatch({ task, before: observationsToState(before), after: observationsToState(after) });
    expect(verdict.accepted).toBe(true);
    await session.record(patch, task, verdict);
    session.updateObservations(after);
    const final = await session.verifyFinal();
    expect(final.failures).toEqual([]);
    expect(final.droppedFixIds).toContain(task.id);
    expect(final.acceptedFixIds).toEqual([]);
    expect(await session.finalPatch()).toBeNull();
    console.log(`Production-only regression evidence: ${session.evidenceDir}`);
  } finally { await session.close(); }
});
