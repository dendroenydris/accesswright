import { access } from "node:fs/promises";
import { execa } from "execa";
import { z } from "zod";
import { defaults } from "../config.js";
import { buildDockerCliEnvironment } from "../sandbox/docker.js";

const guard = "ACCESSWRIGHT-METADATA";

/** Native dedicated Linux host only: target containers must not obtain the verifier's Google workload identity. */
export async function assertHostedVerifierNetwork(): Promise<void> {
  try {
    if (process.platform !== "linux" || (process.env.DOCKER_HOST && process.env.DOCKER_HOST !== "unix:///var/run/docker.sock")) throw new Error("Unsupported verifier host");
    for (const marker of ["/.dockerenv", "/run/.containerenv"]) {
      let absent = false;
      try { await access(marker); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") absent = true; else throw error; }
      if (!absent) throw new Error("Verifier must inspect its native host firewall");
    }
    const dockerOptions = { env: buildDockerCliEnvironment(process.env), extendEnv: false,
      timeout: defaults.hostedHttpHeadersTimeoutMs, maxBuffer: defaults.firestoreResponseMaxBytes };
    const context = await execa("docker", ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], dockerOptions);
    z.literal("unix:///var/run/docker.sock").parse(JSON.parse(context.stdout) as unknown);
    const info = await execa("docker", ["info", "--format", "{{json .SecurityOptions}}"], dockerOptions);
    const security = z.array(z.string()).parse(JSON.parse(info.stdout) as unknown);
    if (security.some(value => /rootless/i.test(value))) throw new Error("Rootless networking does not use the inspected forwarding rules");
    for (const [binary, address] of [["iptables-save", "169.254.169.254/32"], ["ip6tables-save", "fd20:ce::254/128"]]) {
      const result = await execa("/usr/bin/sudo", ["-n", "--", "/usr/sbin/" + binary, "-t", "filter"], {
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" }, extendEnv: false,
        timeout: defaults.hostedHttpHeadersTimeoutMs, maxBuffer: defaults.firestoreResponseMaxBytes,
      });
      const rules = result.stdout.split("\n").map(line => line.trim());
      const expected = [
        "-A " + guard + " -d " + address + " -p udp -m udp --dport 53 -j RETURN",
        "-A " + guard + " -d " + address + " -p tcp -m tcp --dport 53 -j RETURN",
        "-A " + guard + " -d " + address + " -j DROP", "-A " + guard + " -j RETURN",
      ];
      if (rules.filter(line => line.startsWith("-A FORWARD "))[0] !== "-A FORWARD -j " + guard ||
        JSON.stringify(rules.filter(line => line.startsWith("-A " + guard + " "))) !== JSON.stringify(expected)) throw new Error("Verifier metadata firewall is unconfirmed");
    }
  } catch { throw new Error("Trusted verifier requires a local rootful Docker daemon and verified IPv4/IPv6 metadata isolation"); }
}
