import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ calls: [] as Array<{ args: readonly string[]; options: Record<string, unknown> }> }));
vi.mock("execa", () => ({ execa: (_name: string, args: readonly string[], options: Record<string, unknown>) => {
  state.calls.push({ args, options });
  return Promise.resolve({ stdout: "127.0.0.1:3000", stderr: "", exitCode: 0, timedOut: false });
} }));
import { dockerCopy, dockerExec, dockerExecDetached, dockerExecResult, getDockerPublishedPort, runDockerContainer, stopDockerContainer } from "../../src/sandbox/docker.js";

it("bounds every Docker control call so a stuck mount cannot hang an entire repair indefinitely", async () => {
  await runDockerContainer({ image: "fixture", name: "accesswright-fixture", detach: true, command: ["sleep", "infinity"] });
  await dockerCopy("/safe/source", "accesswright-fixture", "/workspace");
  await dockerExec("accesswright-fixture", ["true"]);
  await dockerExecDetached("accesswright-fixture", ["true"]);
  await dockerExecResult("accesswright-fixture", ["true"]);
  await getDockerPublishedPort("accesswright-fixture", 3000);
  await stopDockerContainer("accesswright-fixture");
  expect(state.calls).toHaveLength(7);
  for (const { options } of state.calls) {
    expect(options.extendEnv).toBe(false);
    expect(typeof options.timeout).toBe("number");
    expect(Number(options.timeout)).toBeGreaterThan(0);
    expect(Number(options.timeout)).toBeLessThanOrEqual(600000);
    expect(options.forceKillAfterDelay).toBe(5000);
  }
});
