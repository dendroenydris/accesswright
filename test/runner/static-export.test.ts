import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createStaticExportHandler, hasStaticExport } from "../../src/runner/static-export-server.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("detects only an actually built Next.js static export", async () => {
  const root = await mkdtemp(join(tmpdir(), "accesswright-export-"));
  roots.push(root);
  expect(await hasStaticExport(root)).toBe(false);
  await mkdir(join(root, "out"));
  await writeFile(join(root, "out/index.html"), "<html>built static</html>");
  expect(await hasStaticExport(root)).toBe(true);
});

it("serves static export with clean paths, Next assets, and no access outside out/", async () => {
  const root = await mkdtemp(join(tmpdir(), "accesswright-export-"));
  roots.push(root);
  await mkdir(join(root, "out/blog"), { recursive: true });
  await mkdir(join(root, "out/_next/static"), { recursive: true });
  await writeFile(join(root, "out/index.html"), "<html>home</html>");
  await writeFile(join(root, "out/blog/index.html"), "<html>blog</html>");
  await writeFile(join(root, "out/_next/static/app.js"), 'console.log("asset");');
  await writeFile(join(root, "not-in-export.txt"), "private marker");

  const server = createServer(createStaticExportHandler(join(root, "out")));
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No bound port");
    const url = "http://127.0.0.1:" + addr.port;
    for (const [path, status, needle] of [
      ["/", 200, "home"],
      ["/blog", 200, "blog"],
      ["/blog/", 200, "blog"],
      ["/_next/static/app.js", 200, "asset"],
      ["/missing", 404, "not found"],
      ["/%2e%2e/not-in-export.txt", 404, "not found"],
      ["/.env", 404, "not found"],
    ] as const) {
      const response = await fetch(url + path);
      expect(response.status, path).toBe(status);
      expect((await response.text()).toLowerCase(), path).toContain(needle);
    }
    const asset = await fetch(url + "/_next/static/app.js");
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect((await fetch(url + "/", { method: "HEAD" })).status).toBe(200);
    expect((await fetch(url + "/", { method: "POST" })).status).toBe(405);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
