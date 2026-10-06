import { describe, expect, it } from "vitest";

import {
  buildDockerCopyArgs,
  buildDockerRunArgs,
  buildDockerCliEnvironment,
  parseDockerPublishedPort,
} from "../../src/sandbox/docker.js";

describe("buildDockerRunArgs", () => {
  it("mounts the repository and passes only explicitly allowed container environment", () => {
    const args = buildDockerRunArgs({
      image: "node:22-bookworm-slim",
      repoPath: "/Volumes/T7/accesswright-tmp/fixtures/example",
      command: ["node", "--version"],
      environment: { NODE_ENV: "development", PORT: "3000" },
    });

    expect(args).toEqual([
      "run",
      "--rm",
      "--init",
      "--workdir",
      "/workspace",
      "--volume",
      "/Volumes/T7/accesswright-tmp/fixtures/example:/workspace",
      "--env",
      "NODE_ENV=development",
      "--env",
      "PORT=3000",
      "node:22-bookworm-slim",
      "node",
      "--version",
    ]);
  });

  it("cuts network when offline is requested", () => {
    expect(
      buildDockerRunArgs({
        image: "node:22-bookworm-slim",
        repoPath: "/tmp/repo",
        command: ["npm", "test"],
        offline: true,
      }),
    ).toContain("none");
  });

  it("publishes a container port to a random loopback host port", () => {
    const args = buildDockerRunArgs({
      image: "node:22-bookworm-slim",
      repoPath: "/tmp/repo",
      command: ["npm", "run", "dev"],
      publishPorts: [{ containerPort: 3000 }],
    });

    expect(args).toContain("127.0.0.1::3000");
  });

  it("supports an explicit loopback host port", () => {
    const args = buildDockerRunArgs({
      image: "node:22-bookworm-slim",
      repoPath: "/tmp/repo",
      command: ["npm", "run", "dev"],
      publishPorts: [{ hostPort: 43123, containerPort: 3000 }],
    });

    expect(args).toContain("127.0.0.1:43123:3000");
  });

  it("can create a sandbox container without any host bind mount", () => {
    const args = buildDockerRunArgs({
      image: "node:22-bookworm-slim",
      command: ["sleep", "infinity"],
      detach: true,
    });

    expect(args).not.toContain("--volume");
    expect(args.at(-2)).toBe("sleep");
    expect(args.at(-1)).toBe("infinity");
  });

  it.each(["OPENAI_API_KEY", "GITHUB_TOKEN", "DATABASE_PASSWORD"])(
    "refuses secret-like container variable %s",
    (name) => {
      expect(() =>
        buildDockerRunArgs({
          image: "node:22-bookworm-slim",
          repoPath: "/tmp/repo",
          command: ["true"],
          environment: { [name]: "secret" },
        }),
      ).toThrow(/secret-like environment variable/i);
    },
  );
});

describe("buildDockerCliEnvironment", () => {
  it("does not forward unrelated host variables into the docker CLI process", () => {
    const env = buildDockerCliEnvironment({
      PATH: "/bin:/usr/bin",
      HOME: "/Users/test",
      OPENAI_API_KEY: "must-not-leak",
      GITHUB_TOKEN: "must-not-leak",
    });

    expect(env).toEqual({ PATH: "/bin:/usr/bin", HOME: "/Users/test" });
  });
});

describe("parseDockerPublishedPort", () => {
  it("parses a loopback IPv4 mapping", () => {
    expect(parseDockerPublishedPort("127.0.0.1:49153\n")).toBe(49153);
  });

  it("rejects a malformed mapping", () => {
    expect(() => parseDockerPublishedPort("not-a-port")).toThrow(/published port/i);
  });
});

describe("buildDockerCopyArgs", () => {
  it("builds a literal docker cp destination", () => {
    expect(buildDockerCopyArgs("/tmp/source", "sandbox-1", "/workspace/source")).toEqual([
      "cp",
      "/tmp/source",
      "sandbox-1:/workspace/source",
    ]);
  });
});
