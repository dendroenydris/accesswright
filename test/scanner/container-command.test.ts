import { describe, expect, it } from "vitest";

import { parseContainerCommand } from "../../src/scanner/container-command.js";

describe("parseContainerCommand", () => {
  it("parses bounded crawl arguments", () => {
    expect(
      parseContainerCommand([
        "crawl",
        "http://127.0.0.1:3000",
        '{"maxDepth":2,"maxPages":50}',
      ]),
    ).toEqual({
      kind: "crawl",
      baseUrl: "http://127.0.0.1:3000",
      maxDepth: 2,
      maxPages: 50,
    });
  });

  it("parses scan arguments", () => {
    expect(
      parseContainerCommand([
        "scan",
        "http://127.0.0.1:3000",
        '["/","/posts/1"]',
        "/workspace/.accesswright/screenshots",
      ]),
    ).toEqual({
      kind: "scan",
      baseUrl: "http://127.0.0.1:3000",
      routes: ["/", "/posts/1"],
      screenshotDir: "/workspace/.accesswright/screenshots",
    });
  });

  it("rejects unsafe scan routes", () => {
    expect(() =>
      parseContainerCommand([
        "scan",
        "http://127.0.0.1:3000",
        '["https://example.com/"]',
        "/tmp/screenshots",
      ]),
    ).toThrow();
  });
});
