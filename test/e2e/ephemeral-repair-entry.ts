import assert from "node:assert/strict";
import { access, readdir, writeFile } from "node:fs/promises";
import { runRepair } from "../../src/core/repair.js";
import { makeRunReport } from "../../src/reporter/report.js";
import { EphemeralRepairSession } from "../../src/runner/ephemeral-repair-session.js";

const startedAt = new Date().toISOString();
const session = await EphemeralRepairSession.prepare({ repoPath: "/input", config: { scan: { mobile: true, darkScheme: false } } });
try {
  assert.notEqual(process.getuid?.(), 0);
  assert.equal(session.sandbox.kind, "ephemeral");
  assert.deepEqual(session.inspection.privateFilesPresent, []);
  assert(!session.inspection.processEnvironmentNames.some(name => /token|key|secret/i.test(name)));
  const result = await runRepair(session, { noLlm: true });
  assert.equal(result.status, "verified");
  assert.equal(result.fixed, 2);
  const patches = await session.journal.exportPatches(result.final.acceptedFixIds);
  const report = makeRunReport({ result, startedAt, finishedAt: new Date().toISOString(), applied: false, checks: session.finalChecks,
    usage: { inputTokens: 0, outputTokens: 0, spentUsd: 0 }, providerVerification: "not-run" });
  assert(report.checks.every(check => check.status === "passed" && check.available));
  // Owned fixture transfer only; the outer test deletes this private payload and its container.
  await writeFile("/tmp/owned-candidate.json", JSON.stringify({ report, patches }), { mode: 0o600, flag: "wx" });
} finally { await session.close(); }
assert.deepEqual(await readdir("/workspace"), []);
await assert.rejects(access(session.sourceRoot), { code: "ENOENT" });
console.log(JSON.stringify({ kind: "owned-secretless-worker", privateSourceRemoved: true, paidCalls: 0 }));
