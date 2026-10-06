import { describe, expect, it } from "vitest";

import {
  crawlSameOriginPaths,
  discoverFileRoutes,
  materializeRoutes,
  normalizeSameOriginHref,
} from "../../src/routes/discovery.js";

describe("discoverFileRoutes", () => {
  it("maps App Router page files, including groups and dynamic patterns", () => {
    expect(
      discoverFileRoutes([
        "app/page.tsx",
        "app/about/page.tsx",
        "app/(marketing)/pricing/page.tsx",
        "app/posts/[id]/page.tsx",
        "app/layout.tsx",
      ]),
    ).toEqual([
      { file: "app/page.tsx", pattern: "/", dynamic: false },
      { file: "app/about/page.tsx", pattern: "/about", dynamic: false },
      { file: "app/(marketing)/pricing/page.tsx", pattern: "/pricing", dynamic: false },
      { file: "app/posts/[id]/page.tsx", pattern: "/posts/[id]", dynamic: true },
    ]);
  });

  it("maps Pages Router files and excludes framework/API files", () => {
    expect(
      discoverFileRoutes([
        "pages/index.tsx",
        "pages/about.tsx",
        "pages/blog/[slug].tsx",
        "pages/_app.tsx",
        "pages/_document.tsx",
        "pages/api/health.ts",
      ]),
    ).toEqual([
      { file: "pages/index.tsx", pattern: "/", dynamic: false },
      { file: "pages/about.tsx", pattern: "/about", dynamic: false },
      { file: "pages/blog/[slug].tsx", pattern: "/blog/[slug]", dynamic: true },
    ]);
  });

  it("supports src/app and src/pages", () => {
    expect(discoverFileRoutes(["src/app/page.tsx", "src/pages/legacy.tsx"])).toEqual([
      { file: "src/app/page.tsx", pattern: "/", dynamic: false },
      { file: "src/pages/legacy.tsx", pattern: "/legacy", dynamic: false },
    ]);
  });

  it("does not treat a non-route extension lookalike as a page", () => {
    expect(discoverFileRoutes(["pages/not-a-routeXtsx"])).toEqual([]);
  });

  it("ignores macOS AppleDouble metadata files", () => {
    expect(
      discoverFileRoutes([
        "pages/._index.tsx",
        "pages/.__app.tsx",
        "app/._page.tsx",
      ]),
    ).toEqual([]);
  });
});

describe("normalizeSameOriginHref", () => {
  it("normalizes same-origin links and drops hashes", () => {
    expect(normalizeSameOriginHref("http://127.0.0.1:3000/start", "/posts/1#content")).toBe(
      "/posts/1",
    );
  });

  it("rejects cross-origin and non-http links", () => {
    expect(normalizeSameOriginHref("http://127.0.0.1:3000/", "https://example.com/x")).toBeNull();
    expect(normalizeSameOriginHref("http://127.0.0.1:3000/", "mailto:test@example.com")).toBeNull();
  });
});

describe("crawlSameOriginPaths", () => {
  it("crawls breadth-first with depth and same-origin constraints", async () => {
    const links = new Map<string, readonly string[]>([
      ["/", ["/about", "/posts/1", "https://example.com/away"]],
      ["/about", ["/deep"]],
      ["/posts/1", ["/posts/2"]],
      ["/deep", ["/too-deep"]],
      ["/posts/2", []],
    ]);

    expect(
      await crawlSameOriginPaths(
        "http://127.0.0.1:3000",
        (path) => Promise.resolve(links.get(path) ?? []),
        { maxDepth: 2, maxPages: 50 },
      ),
    ).toEqual(["/", "/about", "/posts/1", "/deep", "/posts/2"]);
  });

  it("caps the number of visited pages", async () => {
    const result = await crawlSameOriginPaths(
      "http://127.0.0.1:3000",
      (path) =>
        Promise.resolve(
          path === "/" ? Array.from({ length: 100 }, (_, index) => `/page-${index}`) : [],
        ),
      { maxDepth: 2, maxPages: 3 },
    );

    expect(result).toEqual(["/", "/page-0", "/page-1"]);
  });
});

describe("materializeRoutes", () => {
  it("uses one crawled example per dynamic pattern", () => {
    const fileRoutes = discoverFileRoutes([
      "app/page.tsx",
      "app/posts/[id]/page.tsx",
      "app/docs/[...slug]/page.tsx",
    ]);

    expect(materializeRoutes(fileRoutes, ["/", "/posts/1", "/posts/2", "/docs/a/b"])).toEqual([
      { file: "app/page.tsx", pattern: "/", urlPath: "/" },
      { file: "app/posts/[id]/page.tsx", pattern: "/posts/[id]", urlPath: "/posts/1" },
      { file: "app/docs/[...slug]/page.tsx", pattern: "/docs/[...slug]", urlPath: "/docs/a/b" },
    ]);
  });

  it("omits dynamic patterns with no crawled example", () => {
    expect(
      materializeRoutes(discoverFileRoutes(["app/posts/[id]/page.tsx"]), ["/"]),
    ).toEqual([]);
  });
});
