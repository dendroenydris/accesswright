import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createNextIntegrationFixture } from "./next-integration.js";

/** Separate controlled Tailwind fixture; never changes existing benchmark ground truth. */
export async function createTailwindIntegrationFixture(root: string): Promise<void> {
  await createNextIntegrationFixture(root);
  const manifest = z.object({ devDependencies: z.record(z.string(), z.string()) }).passthrough().parse(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
  Object.assign(manifest.devDependencies, { tailwindcss: "4.3.3", "@tailwindcss/postcss": "4.3.3", postcss: "8.5.16" });
  await writeFile(join(root, "package.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(root, "postcss.config.mjs"), 'export default { plugins: { "@tailwindcss/postcss": {} } };\n');
  await writeFile(join(root, "app/globals.css"), '@import "tailwindcss";\n:root { --brand-muted: #cccccc; }\n');
  const layout = await readFile(join(root, "app/layout.tsx"), "utf8");
  await writeFile(join(root, "app/layout.tsx"), 'import "./globals.css";\n' + layout);
  await writeFile(join(root, "app/page.tsx"), `export default function Page() { return <>
<h1>Runtime palette fixture</h1>
<p id="clean">Content must remain present.</p>
<p id="palette-target" className="text-gray-400 bg-white">Make this local text readable.</p>
<p id="passing-palette" className="text-gray-700 bg-white">This clean palette example must remain unchanged.</p>
<p id="shared-token" style={{ color: "var(--brand-muted)", backgroundColor: "#ffffff" }}>A shared design token requires a proposal, not an automatic override.</p>
<a href="/help">Help</a>
</>; }\n`);
}
