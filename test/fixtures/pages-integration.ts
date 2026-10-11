import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SourceLocation } from "../../src/types/schemas.js";

/** Owned compatibility fixtures use a separate controlled HTTP data service in the target sandbox. */
export async function createPagesIntegrationFixture(root: string, nextVersion: "12.3.7" | "13.5.11" | "14.2.35" | "15.5.27" | "16.3.8", language: "tsx" | "jsx"): Promise<SourceLocation[]> {
  const typed = language === "tsx";
  // Next 12-14 support React 18 and map sources only through webpack, so they run without Turbopack.
  const legacy = Number(nextVersion.split(".")[0]) < 15, react = legacy ? "18.3.1" : "19.3.0", typesReact = legacy ? "18.3.31" : "19.3.0";
  const index = `import Head from "next/head";
export default function Index({ title }${typed ? ': { title: string }' : ''}) { return <main><Head><title>Pages fixture</title></Head><h1>{title}</h1><p>Clean content must remain.</p><button id="pages-save" aria-bogus="invalid" style={{ padding: 20 }}>Save</button><a href="/item/alpha">Item alpha</a></main>; }
export async function getServerSideProps() { const response = await fetch("http://127.0.0.1:4100/data"); if (!response.ok) throw new Error("External fixture service unavailable"); const data = await response.json(); if (data.title !== "External fixture record") throw new Error("Unexpected external fixture data"); return { props: { title: data.title } }; }\n`;
  const item = `import Head from "next/head";
export default function Item({ slug }${typed ? ': { slug: string }' : ''}) { return <main><Head><title>Dynamic item</title></Head><h1>Item {slug}</h1><button id="item-save" aria-bogus="invalid" style={{ padding: 20 }}>Save item</button><a href="/">Home</a></main>; }
export async function getServerSideProps(context${typed ? ': { params?: { slug?: string } }' : ''}) { return { props: { slug: context.params?.slug ?? "missing" } }; }\n`;
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "accesswright-pages-compatibility-fixture", version: "1.0.0", private: true, type: "module",
      scripts: { dev: "node scripts/server.mjs dev", start: "node scripts/server.mjs start", build: "next build", typecheck: "tsc --noEmit", lint: "eslint pages --max-warnings=0", test: "node --test test/content.test.mjs" },
      dependencies: { next: nextVersion, react, "react-dom": react },
      devDependencies: { typescript: "5.9.3", "@types/node": "26.6.4", "@types/react": typesReact, eslint: "10.12.0", "typescript-eslint": "8.71.0" } }, null, 2),
    "next.config.mjs": 'export default { reactStrictMode: true, poweredByHeader: false, experimental: { cpus: 1 } };\n',
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2017", lib: ["dom", "dom.iterable", "esnext"], allowJs: true, checkJs: false, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: "esnext", moduleResolution: "bundler", resolveJsonModule: true, isolatedModules: true, jsx: "preserve", incremental: true, plugins: [{ name: "next" }] }, include: ["next-env.d.ts", "pages/**/*", ".next/types/**/*.ts"], exclude: ["node_modules"] }, null, 2),
    "eslint.config.mjs": 'import tseslint from "typescript-eslint";\nexport default tseslint.config({ files: ["**/*.{js,jsx,ts,tsx}"], extends: tseslint.configs.recommended, languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } });\n',
    [`pages/index.${language}`]: index,
    [`pages/item/[slug].${language}`]: item,
    [`pages/_document.${language}`]: 'import { Html, Head, Main, NextScript } from "next/document";\nexport default function Document() { return <Html lang="en"><Head /><body><Main /><NextScript /></body></Html>; }\n',
    "scripts/server.mjs": 'import { createServer } from "node:http";\nimport { spawn } from "node:child_process";\nconst mode = process.argv[2]; if (!["dev", "start"].includes(mode)) throw new Error("Invalid fixture server mode");\nconst data = createServer((req,res) => { if (req.url !== "/data") { res.writeHead(404); res.end(); return; } res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ title: "External fixture record" })); });\nawait new Promise((resolve,reject) => { data.once("error",reject); data.listen(4100,"127.0.0.1",resolve); });\nconst child = spawn(process.execPath,["node_modules/next/dist/bin/next",mode,...(mode === "dev" ? ' + (legacy ? "[]" : '["--turbopack"]') + ' : []),...process.argv.slice(3)],{stdio:"inherit",env:process.env});\nchild.on("exit", code => { data.close(); process.exitCode = code ?? 1; });\n',
    "test/content.test.mjs": `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\ntest("clean content is retained",async()=>{const source=await readFile(new URL("../pages/index.${language}",import.meta.url),"utf8");assert.ok(source.includes("Clean content must remain."));});\n`,
    ".env.local": "ACCESSWRIGHT_FIXTURE_PRIVATE_VALUE=must-not-enter-container\n",
  };
  for (const [path, source] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), source); }
  return [[`pages/index.${language}`, index], [`pages/item/[slug].${language}`, item]].map(([file, source]) => {
    if (!file || !source) throw new Error("Missing fixture source");
    const offset = source.indexOf("<button"); const preceding = source.slice(0, offset).split("\n");
    return { file, line: preceding.length, column: (preceding.at(-1)?.length ?? 0) + 1 };
  });
}
