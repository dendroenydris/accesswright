import { expect, it } from "vitest";
import { IsolatedDockerSession } from "../../src/sandbox/session.js";

const options = { name: "accesswright-storage", image: "fixture:1", runtime: "/external/dist", dependencies: "/external/node_modules", packageJson: "/external/package.json", evidence: "/external/evidence", offline: true };

it("reuses existing dependencies by default instead of copying them into Docker storage", () => {
  const session = new IsolatedDockerSession(options);
  expect(session.plan.runtimeVolume).toBeUndefined();
  expect(session.plan.application.extraVolumes).toContainEqual({ hostPath: options.dependencies, containerPath: "/accesswright/node_modules", readOnly: true });
  expect(session.plan.application.extraVolumes?.every(volume => volume.readOnly)).toBe(true);
  expect(session.plan.browser.extraVolumes).toContainEqual({ hostPath: options.evidence, containerPath: "/evidence", readOnly: false });
});

it("uses a copied volume only when the caller explicitly selects it", () => {
  const session = new IsolatedDockerSession({ ...options, ioMode: "copy" });
  expect(session.plan.runtimeVolume).toBe("accesswright-storage-runtime");
});
