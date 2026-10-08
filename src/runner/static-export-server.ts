#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { stat, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import type { RequestListener, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const mimeTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
};

export async function hasStaticExport(workspace: string): Promise<boolean> {
  try {
    const html = await stat(join(workspace, "out", "index.html"));
    return html.isFile();
  } catch {
    return false;
  }
}

function sendError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  response.end(message);
}

/** Serve only already-generated public export bytes; never run source code or fetch dependencies. */
export function createStaticExportHandler(directory: string): RequestListener {
  const root = resolve(directory);
  return (request, response) => {
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendError(response, 405, "method not allowed");
        return;
      }
      let urlPath: string;
      try {
        urlPath = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
      } catch {
        sendError(response, 404, "not found");
        return;
      }
      if (
        !urlPath.startsWith("/") ||
        urlPath.includes("\\") ||
        urlPath.includes("\0") ||
        urlPath.split("/").some(component => component === "." || component === ".." || component.startsWith(".") && component.length > 0)
      ) {
        sendError(response, 404, "not found");
        return;
      }
      const path = urlPath.replace(/^\/+/, "");
      const candidates = urlPath.endsWith("/")
        ? [join(path, "index.html")]
        : [path, path + ".html", join(path, "index.html")];
      const rootReal = await realpath(root);
      for (const candidate of candidates) {
        const absolute = resolve(root, candidate);
        if (!absolute.startsWith(root + sep)) continue;
        try {
          const file = await realpath(absolute);
          if (!file.startsWith(rootReal + sep)) continue;
          const fileStat = await stat(file);
          if (!fileStat.isFile()) continue;
          const mime = mimeTypes[extname(file).toLowerCase()] ?? "application/octet-stream";
          response.writeHead(200, {
            "content-type": mime,
            "content-length": fileStat.size,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          if (request.method === "HEAD") {
            response.end();
            return;
          }
          const stream = createReadStream(file);
          stream.on("error", () => response.destroy());
          stream.pipe(response);
          return;
        } catch {
          // A missing path is not permission to serve any other directory.
        }
      }
      sendError(response, 404, "not found");
    })().catch(() => sendError(response, 503, "unavailable"));
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await stat("/.dockerenv");
    if (process.platform !== "linux" || process.env.ACCESSWRIGHT_ISOLATED_TARGET !== "1") {
      throw new Error("Static export server requires the isolated Docker target");
    }
    const port = Number(process.argv[2]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error("Static export server needs a bounded port");
    }
    createServer(createStaticExportHandler("/workspace/out")).listen(port, "0.0.0.0");
  } catch {
    process.stderr.write("Isolated static export server refused to start\n");
    process.exitCode = 1;
  }
}
