import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";
import { DockerRepairSession } from "../../src/runner/repair-session.js";
import { planFixTasks } from "../../src/planner/planner.js";
import { applyInlineContrastFix } from "../../src/fixers/contrast-patch.js";
import { observationsToState } from "../../src/scanner/observations.js";
import { verifyPerPatch } from "../../src/verifier/per-patch.js";

it("waits for a patched dev route to recover but rejects a persistent 404 before production verification", async () => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
  await mkdir(tempRoot, { recursive: true });
  const fixture = await mkdtemp(join(tempRoot, "next-reload-fixture-"));
  await createNextIntegrationFixture(fixture);
  const session = await DockerRepairSession.prepare({ repoPath: fixture, tempRoot, runtimeRoot: process.cwd(), privateDiagnostics: true,
    config: { scan: { mobile: true, darkScheme: false }, offline: true } });
  try {
    const before = session.observations;
    const task = planFixTasks(observationsToState(before).violations).find(candidate => candidate.ruleId === "color-contrast");
    if (!task?.source) throw new Error("The contrast target must be source-mapped");
    const patch = applyInlineContrastFix(await session.readSource(task.source.file), task);
    const change = patch?.changes[0];
    if (!patch || !change) throw new Error("Expected an actual contrast optimization");
    // A controlled first-response 404 exercises readiness without depending on a timing race in Next.js.
    const transient = 'if (process.env.NODE_ENV === "development" && reloadPending) { reloadPending = false; notFound(); }';
    change.after = 'import { notFound } from "next/navigation";\nlet reloadPending = true;\n' +
      change.after.replace("function Page() {", "function Page() { " + transient);
    const normalized = await session.applyPatch(patch);
    const after = await session.scan(task.routes, "reload-candidate");
    const verification = verifyPerPatch({ task, before: observationsToState(before.filter(page => task.routes.includes(page.route))), after: observationsToState(after) });
    expect(verification.accepted, JSON.stringify(verification)).toBe(true);
    await session.record(normalized, task, verification);
    session.updateObservations(after);

    const broken = await session.applyPatch({ taskId: "persistent-404", changes: [{ path: change.path,
      before: change.after, after: change.after.replace(transient, "if (reloadPending) { notFound(); }") }] });
    await expect(session.scan(task.routes, "persistent-404")).rejects.toThrow("incomplete scan cannot be accepted");
    expect(await readFile(join(session.evidenceDir, "browser-ready-diagnostic.txt"), "utf8")).toContain("Application did not serve a successful ready response");
    await session.revertPatch(broken);
    const recovered = await session.scan(task.routes, "reload-recovered");
    expect(verifyPerPatch({ task, before: observationsToState(before.filter(page => task.routes.includes(page.route))), after: observationsToState(recovered) }).accepted).toBe(true);
    session.updateObservations(recovered);

    const final = await session.verifyFinal();
    expect(final.failures).toEqual([]);
    expect(final.acceptedFixIds).toContain(task.id);
    expect(session.finalChecks.map(check => check.status), JSON.stringify(session.finalChecks)).toEqual(["passed", "passed", "passed", "passed"]);
    console.log(`Dev reload integration evidence: ${session.evidenceDir}`);
  } finally { await session.close(); }
});
