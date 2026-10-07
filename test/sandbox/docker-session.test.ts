import { describe, expect, it } from "vitest";
import { buildDockerRunArgs } from "../../src/sandbox/docker.js";
import { buildIsolatedSessionPlan } from "../../src/sandbox/session.js";

describe("application and verifier isolation", () => {
  it("does not mount source, credentials or writable evidence into the application container", () => {
    const plan = buildIsolatedSessionPlan({ name: "accesswright-fixture", image: "fixture:1", runtime: "/owned/dist", dependencies: "/owned/node_modules", packageJson: "/owned/package.json", evidence: "/owned/evidence", offline: true });
    expect(plan.application.repoPath).toBeUndefined();
    expect(plan.application.extraVolumes?.every(volume => volume.readOnly)).toBe(true);
    expect(plan.application.extraVolumes?.some(volume => volume.containerPath === "/evidence")).toBe(false);
    expect(plan.browser.extraVolumes).toContainEqual({ hostPath: "/owned/evidence", containerPath: "/evidence", readOnly: false });
    expect(plan.network.internal).toBe(true);
    expect(plan.application.network).toBeUndefined();
    expect(plan.browser.network).toBe("accesswright-fixture-network");
    expect(buildDockerRunArgs(plan.browser)).toContain("accesswright-fixture-network");
  });
  it("rejects malformed session names rather than turning them into Docker flags", () => {
    expect(() => buildIsolatedSessionPlan({ name: "--privileged", image: "fixture:1", runtime: "/owned/dist", dependencies: "/owned/node_modules", packageJson: "/owned/package.json", evidence: "/owned/evidence", offline: false })).toThrow();
  });
});
