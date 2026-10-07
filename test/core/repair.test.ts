import { describe, expect, it } from "vitest";
import { AccesswrightConfigSchema } from "../../src/types/schemas.js";
import type { FixTask, Patch, Violation } from "../../src/types/schemas.js";
import { BrowserObservationSchema } from "../../src/scanner/observations.js";
import type { BrowserObservation } from "../../src/scanner/observations.js";
import type { PerPatchVerificationResult } from "../../src/verifier/per-patch.js";
import type { FinalVerificationResult } from "../../src/verifier/final.js";
import { runRepair } from "../../src/core/repair.js";
import type { RepairRuntime } from "../../src/core/repair.js";

const source = 'export const Button = () => <button id="save" aria-bogus="bad">Save</button>;\n';
const location = { file: "components/Button.tsx", line: 1, column: 29 };
const violation: Violation = { ruleId: "aria-valid-attr", route: "/", impact: "serious", target: ["#save"], html: '<button aria-bogus="bad">Save</button>', failureSummary: null, source: location };
function observation(violations: Violation[], hidden = false): BrowserObservation {
  return BrowserObservationSchema.parse({ route: "/", condition: "desktop-light", violations, incomplete: [], aria: hidden ? [] : [{ id: "save", role: "button", name: "Save", text: "Save", interactive: true }], ariaTree: "- button Save", probeFailures: [], probeUnavailable: [], contexts: [], screenshot: "page.png", darkMediaDetected: false, sourceFiles: [location.file] });
}

class FakeRuntime implements RepairRuntime {
  config = AccesswrightConfigSchema.parse({ scan: { mobile: false } });
  observations = [observation([violation])];
  source = source;
  events: string[] = [];
  recorded: Patch[] = [];
  scans = 0;
  hide = false;
  introduceViolation = false;
  failFinal = false;
  finalSeen = false;
  readSource() { return Promise.resolve(this.source); }
  applyPatch(patch: Patch) {
    this.events.push("candidate");
    const change = patch.changes[0];
    if (!change || this.source !== change.before) throw new Error("stale source");
    this.source = change.after;
    return Promise.resolve(patch);
  }
  revertPatch(patch: Patch) { this.events.push("revert"); this.source = patch.changes[0]?.before ?? this.source; return Promise.resolve(); }
  scan() {
    this.scans += 1;
    const unchanged = this.source === source;
    const violations = unchanged ? [violation] : this.introduceViolation ? [{ ...violation, ruleId: "button-name" }] : [];
    return Promise.resolve([observation(violations, !unchanged && this.hide)]);
  }
  affectedRoutes() { return ["/"]; }
  updateObservations(after: BrowserObservation[]) { this.observations = after; }
  record(patch: Patch, _task: FixTask, verification: PerPatchVerificationResult) {
    if (!verification.accepted) throw new Error("unverified");
    this.events.push("record"); this.recorded.push(patch); return Promise.resolve();
  }
  verifyFinal(): Promise<FinalVerificationResult> {
    this.events.push("final"); this.finalSeen = true;
    return Promise.resolve({ acceptedFixIds: this.recorded.map(patch => patch.taskId), droppedFixIds: [], failures: this.failFinal ? [{ check: "build", id: "actual-build-failure" }] : [] });
  }
  finalPatch() { if (!this.finalSeen) throw new Error("before final"); this.events.push("patch-output"); return Promise.resolve(this.recorded[0] ?? null); }
}

describe("real repair orchestrator gates", () => {
  it("records only per-patch accepted fixes and returns a source patch only after the final gate", async () => {
    const runtime = new FakeRuntime();
    const result = await runRepair(runtime, { noLlm: true });
    expect(runtime.events).toEqual(["candidate", "record", "final", "patch-output"]);
    expect(result).toMatchObject({ fixed: 1, rejected: 0, status: "verified", patch: { changes: [{ path: location.file }] } });
    expect(result.patch?.changes[0]?.after).not.toContain("aria-bogus");
  });
  it("reverts hidden content and never records it as a verified fix", async () => {
    const runtime = new FakeRuntime(); runtime.hide = true;
    const result = await runRepair(runtime, { noLlm: true });
    expect(runtime.recorded).toEqual([]);
    expect(runtime.source).toBe(source);
    expect(result).toMatchObject({ fixed: 0, rejected: 1, patch: null });
  });
  it("does not return an applyable patch when final checks fail, even if the verifier retained an ID", async () => {
    const runtime = new FakeRuntime(); runtime.failFinal = true;
    const result = await runRepair(runtime, { noLlm: true });
    expect(result).toMatchObject({ status: "blocked", fixed: 0, patch: null });
    expect(runtime.events).not.toContain("patch-output");
  });
  it("confirms a new violation once but still rejects it when persistent", async () => {
    const runtime = new FakeRuntime(); runtime.introduceViolation = true;
    const result = await runRepair(runtime, { noLlm: true });
    expect(runtime.scans).toBeGreaterThanOrEqual(3);
    expect(result.rejected).toBe(1);
    expect(runtime.recorded).toEqual([]);
  });
  it("honors ignored source paths without invoking a candidate or provider", async () => {
    const runtime = new FakeRuntime(); runtime.config.ignore.paths = ["components/**"];
    const result = await runRepair(runtime, { noLlm: true });
    expect(runtime.events).not.toContain("candidate");
    expect(result.fixed).toBe(0);
    expect(result.ignored).toBe(1);
  });
  it("keeps semantic tasks unresolved when --no-llm is explicit", async () => {
    const runtime = new FakeRuntime(); runtime.observations = [observation([{ ...violation, ruleId: "button-name" }])];
    const result = await runRepair(runtime, { noLlm: true });
    expect(result.needsHuman).toBe(1);
    expect(runtime.events).not.toContain("candidate");
  });
});
