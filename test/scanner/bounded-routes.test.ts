import { expect, it } from "vitest";

import { mapRoutesBounded } from "../../src/scanner/bounded-routes.js";

it("visits every route exactly once with bounded concurrency, retaining input order", async () => {
  let active = 0, peak = 0;
  const seen: number[] = [];
  const output = await mapRoutesBounded([0, 1, 2, 3, 4, 5, 6], 3, async id => {
    active += 1;
    peak = Math.max(peak, active);
    seen.push(id);
    await Promise.resolve();
    await Promise.resolve();
    active -= 1;
    return id * 7;
  });
  expect(output).toEqual([0, 7, 14, 21, 28, 35, 42]);
  expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(3);
  expect(active).toBe(0);
});

it("never returns a partial successful scan after any route fails and waits for active workers", async () => {
  let active = 0;
  await expect(mapRoutesBounded(["/", "/fail", "/help", "/other"], 2, async route => {
    active += 1;
    await Promise.resolve();
    active -= 1;
    if (route === "/fail") throw new Error("critical browser failure");
    return route;
  })).rejects.toThrow(/critical browser failure/i);
  expect(active).toBe(0);
});

it("enforces explicit scan concurrency bounds and handles empty selections", async () => {
  expect(await mapRoutesBounded([], 2, () => Promise.resolve(1))).toEqual([]);
  await expect(mapRoutesBounded(["/"], 0, () => Promise.resolve(1))).rejects.toThrow(/concurrency/i);
  await expect(mapRoutesBounded(["/"], 5, () => Promise.resolve(1))).rejects.toThrow(/concurrency/i);
});
