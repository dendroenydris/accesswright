/** Minimal server-rendered operator dashboard; no static export or public backend. */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const config = { reactStrictMode: true, output: "standalone", outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)) };
export default config;
