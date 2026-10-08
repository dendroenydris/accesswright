import { expect, it } from "vitest";
import { enforceInteractionProbeCapacity, isDetachedInteractionNodeError } from "../../src/scanner/browser-scan.js";

it("probes every control up to the explicit resource cap without silently dropping any", () => {
  expect(enforceInteractionProbeCapacity(0)).toBe(0);
  expect(enforceInteractionProbeCapacity(151)).toBe(151);
  expect(enforceInteractionProbeCapacity(2048)).toBe(2048);
  expect(() => enforceInteractionProbeCapacity(2049)).toThrow(/2049.*2048/);
  expect(() => enforceInteractionProbeCapacity(-1)).toThrow(/invalid/i);
});

it("distinguishes recoverable stale CDP identities from unrelated browser failures", () => {
  expect(isDetachedInteractionNodeError(new Error("Protocol error (CSS.getComputedStyleForNode): Could not find node with given id"))).toBe(true);
  expect(isDetachedInteractionNodeError(new Error("Interactive marker detached during full probe"))).toBe(true);
  expect(isDetachedInteractionNodeError(new Error("Axe analysis failed"))).toBe(false);
});
