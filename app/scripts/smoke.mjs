import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const address = listener.address();
if (!address || typeof address === "string") throw new Error("Could not allocate local HTTP port");
const port = address.port;
await new Promise(resolve => listener.close(resolve));

const username = "local-smoke";
const password = "temporary-local-smoke-password-not-a-secret";
const auth = "Basic " + Buffer.from(username + ":" + password).toString("base64");
const child = spawn(process.execPath, [
  join(root, "node_modules/next/dist/bin/next"), "start",
  "--hostname", "127.0.0.1", "--port", String(port),
], {
  cwd: root,
  env: {
    ...process.env,
    ACCESSWRIGHT_DASHBOARD_USERNAME: username,
    ACCESSWRIGHT_DASHBOARD_PASSWORD: password,
    ACCESSWRIGHT_GCP_PROJECT_ID: "",
    ACCESSWRIGHT_FIRESTORE_RUN_COLLECTION: "",
    NODE_ENV: "production",
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let errors = "";
child.stderr?.on("data", chunk => { errors = (errors + chunk.toString()).slice(-3000); });
const origin = "http://127.0.0.1:" + port;
try {
  let ready = false;
  for (let attempt = 0; attempt < 75; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(origin + "/", { signal: AbortSignal.timeout(2000) });
      if (response.status === 401) { ready = true; await response.body?.cancel(); break; }
      await response.body?.cancel();
    } catch { /* Local Next.js server is starting. */ }
    await delay(200);
  }
  assert(ready, "Local production dashboard did not start; " + errors.replaceAll(password, "[redacted]"));
  const denied = await fetch(origin + "/");
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate") ?? "", /^Basic realm=/);
  assert.match(denied.headers.get("cache-control") ?? "", /no-store/);
  const invalid = await fetch(origin + "/", { headers: { authorization: "Basic " + Buffer.from(username + ":wrong").toString("base64") } });
  assert.equal(invalid.status, 401);
  const home = await fetch(origin + "/", { headers: { authorization: auth } });
  assert.equal(home.status, 200);
  const body = await home.text();
  assert.match(body, /Accessibility repair runs/);
  assert.match(body, /Dashboard backend unavailable or unauthorized/);
  assert(!body.includes(password), "Operator credential leaked into HTML");
  const details = await fetch(origin + "/runs/run-test", { headers: { authorization: auth } });
  assert.equal(details.status, 200);
  assert.match(await details.text(), /could not be retrieved securely/);
  console.log("Dashboard production HTTP smoke: unauthorized 401, invalid password 401, operator 200, missing backend fails closed, run details 200");
} finally {
  if (child.pid && child.exitCode === null) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
  }
}
