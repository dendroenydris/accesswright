/** No shell evaluation: dispatch only fixed Node/npm executables inside the Docker target. */
export function targetServerCommand(
  mode: "dev" | "production",
  scripts: Readonly<Record<string, string>>,
  port: number,
): string[] {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid isolated target port");
  }
  const listening = ["--hostname", "0.0.0.0", "--port", String(port)];
  if (mode === "dev") {
    if (!scripts.dev) throw new Error("A development server script is required");
    return ["npm", "run", "dev", "--", ...listening];
  }
  // Some Next.js projects use npm start for a dev-only loop and provide a
  // separate serve script. A verified production build must be served with
  // next start, not rebuilt through an untrusted dev-only command.
  const start = scripts.start?.trim();
  if (start && !/(?:^|[\s'"=])next\s+dev(?:\s|$)/.test(start)) {
    return ["npm", "run", "start", "--", ...listening];
  }
  return ["node", "node_modules/next/dist/bin/next", "start", ...listening];
}
