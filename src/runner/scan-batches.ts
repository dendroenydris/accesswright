export interface RouteObservationIdentity {
  route: string;
  condition: string;
}

/** A bounded browser process never has to retain all real-site routes at once. */
export function partitionRouteScans(
  routes: readonly string[],
  batchSize = 6,
): string[][] {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 12) {
    throw new Error("Invalid browser route scan batch size limit");
  }
  if (new Set(routes).size !== routes.length) {
    throw new Error("Duplicate routes in isolated browser scan request");
  }
  const chunks: string[][] = [];
  for (let i = 0; i < routes.length; i += batchSize) {
    chunks.push(routes.slice(i, i + batchSize));
  }
  return chunks;
}

/** Any missing, unsolicited or duplicated baseline observation fails closed. */
export function validateRouteScanChunk(
  routes: readonly string[],
  observations: readonly RouteObservationIdentity[],
  mobile: boolean,
): void {
  const requested = new Set(routes);
  const actual = new Set<string>();
  for (const item of observations) {
    if (!requested.has(item.route)) throw new Error("Browser returned an unsolicited route");
    const key = item.route + "|" + item.condition;
    if (actual.has(key)) throw new Error("Duplicate route-condition observation");
    actual.add(key);
  }
  for (const route of routes) {
    if (!actual.has(route + "|desktop-light")) throw new Error("Browser omitted a requested route");
    if (mobile && !actual.has(route + "|mobile-light")) {
      throw new Error("Browser omitted a requested mobile route scan");
    }
  }
}
