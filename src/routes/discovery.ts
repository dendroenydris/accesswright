export interface FileRoute {
  file: string;
  pattern: string;
  dynamic: boolean;
}

export interface ConcreteRoute {
  file: string;
  pattern: string;
  urlPath: string;
}

export interface CrawlOptions {
  maxDepth: number;
  maxPages: number;
}

const routeExtensions = /\.(?:js|jsx|ts|tsx|mjs|mts)$/;

function appRoute(file: string): FileRoute | null {
  const normalized = file.startsWith("src/") ? file.slice(4) : file;
  if (!normalized.startsWith("app/") || !/\/page\.(?:js|jsx|ts|tsx|mjs|mts)$/.test(normalized)) {
    if (!/^app\/page\.(?:js|jsx|ts|tsx|mjs|mts)$/.test(normalized)) return null;
  }

  const withoutApp = normalized.slice("app/".length).replace(/(?:^|\/)page\.(?:js|jsx|ts|tsx|mjs|mts)$/, "");
  const segments = withoutApp
    .split("/")
    .filter(Boolean)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .filter((segment) => !segment.startsWith("@"));
  const pattern = segments.length === 0 ? "/" : `/${segments.join("/")}`;
  return { file, pattern, dynamic: segments.some((segment) => segment.includes("[")) };
}

function pagesRoute(file: string): FileRoute | null {
  const normalized = file.startsWith("src/") ? file.slice(4) : file;
  if (!normalized.startsWith("pages/") || !routeExtensions.test(normalized)) return null;

  const relative = normalized.slice("pages/".length);
  if (relative.startsWith("api/") || /^_(?:app|document|error)\./.test(relative)) return null;

  const withoutExtension = relative.replace(routeExtensions, "");
  const segments = withoutExtension.split("/").filter(Boolean);
  if (segments.at(-1) === "index") segments.pop();
  const pattern = segments.length === 0 ? "/" : `/${segments.join("/")}`;
  return { file, pattern, dynamic: segments.some((segment) => segment.includes("[")) };
}

export function discoverFileRoutes(files: readonly string[]): FileRoute[] {
  const routes: FileRoute[] = [];
  for (const file of files) {
    if (file.split("/").some((segment) => segment.startsWith("._") || segment === ".DS_Store")) {
      continue;
    }
    const route = appRoute(file) ?? pagesRoute(file);
    if (route !== null) routes.push(route);
  }
  return routes;
}

export function normalizeSameOriginHref(baseUrl: string, href: string): string | null {
  let base: URL;
  let target: URL;
  try {
    base = new URL(baseUrl);
    target = new URL(href, base);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(target.protocol) || target.origin !== base.origin) {
    return null;
  }

  return `${target.pathname}${target.search}`;
}

export async function crawlSameOriginPaths(
  baseUrl: string,
  getLinks: (path: string) => Promise<readonly string[]>,
  options: CrawlOptions,
): Promise<string[]> {
  const queue: Array<{ path: string; depth: number }> = [{ path: "/", depth: 0 }];
  const queued = new Set<string>(["/"]);
  const visited = new Set<string>();
  const result: string[] = [];

  while (queue.length > 0 && result.length < options.maxPages) {
    const current = queue.shift();
    if (current === undefined || visited.has(current.path)) continue;

    visited.add(current.path);
    result.push(current.path);
    if (current.depth >= options.maxDepth) continue;

    const pageUrl = new URL(current.path, baseUrl).toString();
    const links = await getLinks(current.path);
    for (const href of links) {
      const normalized = normalizeSameOriginHref(pageUrl, href);
      if (normalized === null || visited.has(normalized) || queued.has(normalized)) continue;
      queued.add(normalized);
      queue.push({ path: normalized, depth: current.depth + 1 });
    }
  }

  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routePatternRegExp(pattern: string): RegExp {
  if (pattern === "/") return /^\/$/;

  const segments = pattern.split("/").filter(Boolean);
  let source = "^";
  for (const segment of segments) {
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) {
      source += "(?:/.*)?";
    } else if (/^\[\.\.\.[^\]]+\]$/.test(segment)) {
      source += "/.+";
    } else if (/^\[[^\]]+\]$/.test(segment)) {
      source += "/[^/]+";
    } else {
      source += `/${escapeRegExp(segment)}`;
    }
  }
  source += "$";
  return new RegExp(source);
}

export function materializeRoutes(
  fileRoutes: readonly FileRoute[],
  crawledPaths: readonly string[],
): ConcreteRoute[] {
  const result: ConcreteRoute[] = [];

  for (const route of fileRoutes) {
    if (!route.dynamic) {
      result.push({ file: route.file, pattern: route.pattern, urlPath: route.pattern });
      continue;
    }

    const matcher = routePatternRegExp(route.pattern);
    const example = crawledPaths.find((path) => {
      const pathname = new URL(path, "http://accesswright.invalid").pathname;
      return matcher.test(pathname);
    });
    if (example !== undefined) {
      result.push({ file: route.file, pattern: route.pattern, urlPath: example });
    }
  }

  return result;
}
