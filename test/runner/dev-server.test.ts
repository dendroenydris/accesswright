import { describe, expect, it } from "vitest";

import {
  buildCopiedDevServerContainerOptions,
  buildDevServerContainerOptions,
} from "../../src/runner/dev-server.js";

describe("buildDevServerContainerOptions", () => {
  it("installs without lifecycle scripts and starts Next inside the Docker sandbox", () => {
    const options = buildDevServerContainerOptions({
      workspace: "/Volumes/T7/accesswright-tmp/build/workspace-abc",
      image: "mcr.microsoft.com/playwright:v1.63.0-noble",
      accesswrightNodeModules: "/Volumes/T7/accesswright-tmp/node_modules",
      accesswrightRuntime: "/Volumes/T7/accesswright-tmp/build/accesswright-dist",
      npmCache: "/Volumes/T7/accesswright-tmp/npm-cache",
      containerName: "accesswright-fixture",
      port: 3000,
    });

    expect(options.repoPath).toBe("/Volumes/T7/accesswright-tmp/build/workspace-abc");
    expect(options.detach).toBe(true);
    expect(options.publishPorts).toEqual([{ containerPort: 3000 }]);
    expect(options.extraVolumes).toEqual([
      {
        hostPath: "/Volumes/T7/accesswright-tmp/node_modules",
        containerPath: "/accesswright/node_modules",
        readOnly: true,
      },
      {
        hostPath: "/Volumes/T7/accesswright-tmp/build/accesswright-dist",
        containerPath: "/accesswright/dist",
        readOnly: true,
      },
      {
        hostPath: "/Volumes/T7/accesswright-tmp/npm-cache",
        containerPath: "/npm-cache",
      },
    ]);
    expect(options.command).toEqual([
      "bash",
      "-lc",
      "npm ci --ignore-scripts --cache /npm-cache && npm install --ignore-scripts --no-save --package-lock=false code-inspector-plugin@2.0.9 --cache /npm-cache && npm run dev -- --hostname 0.0.0.0 --port 3000",
    ]);
    expect(options.environment).toEqual({
      NEXT_TELEMETRY_DISABLED: "1",
    });
  });
});

describe("buildCopiedDevServerContainerOptions", () => {
  it("starts an empty writable workspace while mounting only accesswright runtime/cache from T7", () => {
    const options = buildCopiedDevServerContainerOptions({
      workspace: "/Volumes/T7/accesswright-tmp/build/workspace-abc",
      image: "mcr.microsoft.com/playwright:v1.63.0-noble",
      accesswrightNodeModules: "/Volumes/T7/accesswright-tmp/node_modules",
      accesswrightRuntime: "/Volumes/T7/accesswright-tmp/build/accesswright-dist",
      npmCache: "/Volumes/T7/accesswright-tmp/npm-cache",
      containerName: "accesswright-fixture",
      port: 3000,
    });

    expect(options.repoPath).toBeUndefined();
    expect(options.detach).toBe(true);
    expect(options.publishPorts).toEqual([{ containerPort: 3000 }]);
    expect(options.extraVolumes).toEqual([
      {
        hostPath: "/Volumes/T7/accesswright-tmp/node_modules",
        containerPath: "/accesswright/node_modules",
        readOnly: true,
      },
      {
        hostPath: "/Volumes/T7/accesswright-tmp/build/accesswright-dist",
        containerPath: "/accesswright/dist",
        readOnly: true,
      },
      {
        hostPath: "/Volumes/T7/accesswright-tmp/npm-cache",
        containerPath: "/npm-cache",
      },
    ]);
    expect(options.command).toEqual(["sleep", "infinity"]);
  });
});
