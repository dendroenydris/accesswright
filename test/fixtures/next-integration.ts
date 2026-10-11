import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Owned synthetic application, executed only in Docker. Not a public-repository benchmark result. */
export async function createNextIntegrationFixture(root: string, next: "13.5.11" | "14.2.35" | "16.3.8" = "16.3.8"): Promise<void> {
  // Next 13-14 support React 18 and map sources only through webpack, so they run without Turbopack.
  const legacy = next !== "16.3.8", react = legacy ? "18.3.1" : "19.3.0";
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "accesswright-next-integration-fixture", version: "1.0.0", private: true, type: "module",
      scripts: { dev: legacy ? "next dev" : "next dev --turbopack", build: "next build", start: "next start", typecheck: "tsc --noEmit", lint: "eslint app components --max-warnings=0", test: "node --test test/invariant.test.mjs" },
      dependencies: { next, react, "react-dom": react },
      devDependencies: { typescript: "5.9.3", "@types/node": "26.6.4", "@types/react": legacy ? "18.3.31" : "19.3.0", eslint: "10.12.0", "typescript-eslint": "8.71.0" },
    }, null, 2),
    "next.config.mjs": "export default { reactStrictMode: true, poweredByHeader: false };\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2017", lib: ["dom", "dom.iterable", "esnext"], allowJs: true, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: "esnext", moduleResolution: "bundler", resolveJsonModule: true, isolatedModules: true, jsx: "preserve", incremental: true, plugins: [{ name: "next" }] }, include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"], exclude: ["node_modules"] }, null, 2),
    "eslint.config.mjs": 'import tseslint from "typescript-eslint";\nexport default tseslint.config(...tseslint.configs.recommended);\n',
    "app/layout.tsx": 'import type { ReactNode } from "react";\nexport const metadata = { title: "Accesswright integration fixture" };\nexport default function Layout({ children }: { children: ReactNode }) { return <html lang="en"><body><main>{children}</main></body></html>; }\n',
    "app/page.tsx": 'import Controls from "../components/Controls";\nexport default function Page() { return <><h1 id="title">Integration fixture</h1><p id="clean">Content must remain present.</p><p id="contrast" style={{ color: "#cccccc", backgroundColor: "#ffffff" }}>Readable information</p><Controls /><a id="help" href="/help">Help</a></>; }\n',
    "components/Controls.tsx": 'export default function Controls() { return <section aria-label="Actions"><p id="hint">Save changes</p><button id="save" type="button" aria-bogus="invalid" style={{ padding: 16 }}>Save</button><button id="unlabeled" type="button" style={{ width: 44, height: 44 }}><svg aria-hidden="true" width="12" height="12"><path d="M0 0h12v12H0z" /></svg></button></section>; }\n',
    "app/help/page.tsx": 'export default function Help() { return <><h1 id="help-title">Help</h1><p id="help-text">Help remains available.</p><a href="/">Home</a></>; }\n',
    "test/invariant.test.mjs": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\ntest("clean content is retained in the source", async () => { const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8"); assert.ok(page.includes("Content must remain present.")); });\n',
    ".env.local": "ACCESSWRIGHT_FIXTURE_PRIVATE_VALUE=must-not-enter-container\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, "utf8");
  }
}
