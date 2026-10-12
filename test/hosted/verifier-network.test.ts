import { access } from "node:fs/promises";
import { execa } from "execa";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { assertHostedVerifierNetwork } from "../../src/hosted/verifier-network.js";

vi.mock("execa", () => ({ execa: vi.fn() }));
vi.mock("node:fs/promises", () => ({ access: vi.fn() }));
const guard = "ACCESSWRIGHT-METADATA";
function rules(ipv6: boolean) {
  const address = ipv6 ? "fd20:ce::254/128" : "169.254.169.254/32";
  return ["*filter", "-A FORWARD -j " + guard,
    "-A " + guard + " -d " + address + " -p udp -m udp --dport 53 -j RETURN",
    "-A " + guard + " -d " + address + " -p tcp -m tcp --dport 53 -j RETURN",
    "-A " + guard + " -d " + address + " -j DROP", "-A " + guard + " -j RETURN", "COMMIT"].join("\n");
}
function response(stdout: string) { return { stdout } as Awaited<ReturnType<typeof execa>>; }
beforeEach(() => {
  vi.stubGlobal("process", { ...process, platform: "linux", env: { PATH: "/usr/bin", OPENAI_API_KEY: "private-key-marker" } });
  vi.mocked(access).mockRejectedValue(Object.assign(new Error("absent"), { code: "ENOENT" }));
  vi.mocked(execa).mockResolvedValueOnce(response('"unix:///var/run/docker.sock"')).mockResolvedValueOnce(response('["name=seccomp"]'))
    .mockResolvedValueOnce(response(rules(false))).mockResolvedValueOnce(response(rules(true)));
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

it("requires both ordered metadata guards while allowing DNS and scrubbing all child environments", async () => {
  await expect(assertHostedVerifierNetwork()).resolves.toBeUndefined(); expect(execa).toHaveBeenCalledTimes(4);
  const calls = z.array(z.tuple([z.string(), z.array(z.string()), z.object({ extendEnv: z.literal(false) }).passthrough()])).parse(vi.mocked(execa).mock.calls);
  expect(JSON.stringify(calls)).not.toContain("private-key-marker");
  expect(calls.every(call => call[2]?.extendEnv === false)).toBe(true);
  expect(calls[2]?.[0]).toBe("/usr/bin/sudo");
  expect(calls[2]?.[1]).toEqual(["-n", "--", "/usr/sbin/iptables-save", "-t", "filter"]);
  expect(calls[3]?.[1]).toEqual(["-n", "--", "/usr/sbin/ip6tables-save", "-t", "filter"]);
});

it.each(["no-drop", "accept-first", "hook-after-accept", "wrong-address", "dns-blocked", "extra-allow"])("refuses unsafe %s forwarding rules", async failure => {
  vi.mocked(execa).mockReset();
  let unsafe = rules(false);
  if (failure === "no-drop") unsafe = unsafe.replace(/.*-j DROP\n/, "");
  else if (failure === "accept-first") unsafe = unsafe.replace("-A " + guard, "-A " + guard + " -j ACCEPT\n-A " + guard);
  else if (failure === "hook-after-accept") unsafe = unsafe.replace("-A FORWARD -j " + guard, "-A FORWARD -j ACCEPT\n-A FORWARD -j " + guard);
  else if (failure === "wrong-address") unsafe = unsafe.replaceAll("169.254.169.254", "169.254.169.253");
  else if (failure === "dns-blocked") unsafe = unsafe.replace("-p udp -m udp --dport 53 -j RETURN", "-p udp -m udp --dport 53 -j DROP");
  else unsafe += "\n-A " + guard + " -j ACCEPT";
  vi.mocked(execa).mockResolvedValueOnce(response('"unix:///var/run/docker.sock"')).mockResolvedValueOnce(response("[]"))
    .mockResolvedValueOnce(response(unsafe));
  await expect(assertHostedVerifierNetwork()).rejects.toThrow(/^Trusted verifier requires/);
});

it("refuses a missing IPv6 guard even when IPv4 is correct", async () => {
  vi.mocked(execa).mockReset();
  vi.mocked(execa).mockResolvedValueOnce(response('"unix:///var/run/docker.sock"')).mockResolvedValueOnce(response("[]"))
    .mockResolvedValueOnce(response(rules(false))).mockResolvedValueOnce(response("*filter\nCOMMIT"));
  await expect(assertHostedVerifierNetwork()).rejects.toThrow(/^Trusted verifier requires/);
});

it.each(["mac", "remote-environment", "remote-context", "rootless", "container", "marker-io", "sudo-denied"])("refuses an unconfirmed %s host without exposing diagnostics", async failure => {
  if (failure === "mac") vi.stubGlobal("process", { ...process, platform: "darwin" });
  else if (failure === "remote-environment") vi.stubGlobal("process", { ...process, env: { DOCKER_HOST: "tcp://private-host:2375" } });
  else if (failure === "container") vi.mocked(access).mockResolvedValueOnce(undefined);
  else if (failure === "marker-io") vi.mocked(access).mockRejectedValueOnce(Object.assign(new Error("private-host-marker"), { code: "EACCES" }));
  else {
    vi.mocked(execa).mockReset();
    vi.mocked(execa).mockResolvedValueOnce(response(failure === "remote-context" ? '"ssh://private-host"' : '"unix:///var/run/docker.sock"'))
      .mockResolvedValueOnce(response(failure === "rootless" ? '["name=rootless"]' : "[]"))
      .mockRejectedValueOnce(new Error("private-host-marker sudo diagnostic"));
  }
  await expect(assertHostedVerifierNetwork()).rejects.toThrow(/^Trusted verifier requires/);
});
