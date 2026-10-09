import { expect, it } from "vitest";
import { targetServerCommand } from "../../src/runner/server-plan.js";

it("uses a built Next production server, never a repository's development start script", () => {
  const scripts = {
    start: "next dev",
    dev: "PORT=3434 cross-env INIT_CWD=$PWD next dev",
    serve: "next start",
  };
  expect(targetServerCommand("production", scripts, 3000)).toEqual([
    "node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000",
  ]);
  expect(targetServerCommand("dev", scripts, 3000)).toEqual([
    "npm", "run", "dev", "--", "--hostname", "0.0.0.0", "--port", "3000",
  ]);
});

it("preserves a real production start script and defaults safely when absent", () => {
  expect(targetServerCommand("production", { start: "next start" }, 3000)).toEqual([
    "npm", "run", "start", "--", "--hostname", "0.0.0.0", "--port", "3000",
  ]);
  expect(targetServerCommand("production", {}, 3000)[0]).toBe("node");
  expect(() => targetServerCommand("dev", {}, 3000)).toThrow(/development/i);
});
