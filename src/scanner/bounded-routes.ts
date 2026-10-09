/**
 * Run real browser route scans with a bounded number of independent contexts.
 * Every route is visited or the entire scan rejects; nothing is treated as
 * verified based on a partial result.
 */
export async function mapRoutesBounded<T, U>(
  routes: readonly T[],
  concurrency: number,
  scan: (route: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("Browser route scan concurrency must be within 1–4");
  }
  const output = new Array<U>(routes.length);
  let cursor = 0;
  let completed = 0;
  let error: Error | null = null;
  const workers = Array.from({ length: Math.min(concurrency, routes.length) }, async () => {
    while (error === null) {
      const index = cursor++;
      if (index >= routes.length) return;
      const route = routes[index];
      if (route === undefined) {
        error = new Error("Browser route list contains an invalid entry");
        return;
      }
      try {
        output[index] = await scan(route, index);
        completed += 1;
      } catch (failure) {
        error = failure instanceof Error ? failure : new Error("A browser route scan failed");
        return;
      }
    }
  });
  // Do not close Chromium until active contexts have had a chance to clean up.
  await Promise.all(workers);
  const capturedError: unknown = error;
  if (capturedError instanceof Error) throw capturedError;
  if (capturedError !== null) throw new Error("A browser route scan failed");
  if (completed !== routes.length) throw new Error("Browser route scan was incomplete");
  return output;
}
