import { afterEach, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { defaults } from "../../src/config.js";
import { collectKeyboardOrder, KeyboardProbeSchema } from "../../src/scanner/keyboard.js";
import { BrowserObservationSchema, observationsToState } from "../../src/scanner/observations.js";

function fixture(values: unknown[], navigateAt?: number) {
  const evaluate = vi.fn((callback: unknown) => { void callback; return Promise.resolve(values.shift()); });
  const dispose = vi.fn(() => Promise.resolve());
  const evaluateHandle = vi.fn((callback: unknown) => { void callback; return Promise.resolve({ evaluate, dispose }); });
  const press = vi.fn((key: string) => { void key; return Promise.resolve(); });
  const page = { evaluateHandle, keyboard: { press }, url: () => navigateAt !== undefined && press.mock.calls.length >= navigateAt ? "https://other.example/" : "http://app/" };
  return { page: page as unknown as Page, evaluate, dispose, evaluateHandle, press };
}
afterEach(() => { vi.unstubAllGlobals(); });

it("records real key sequences in both directions and retains unreached DOM controls", async () => {
  const f = fixture([3, true, 0, 2, -1, true, 0, -1]);
  const result = await collectKeyboardOrder(f.page);
  expect(result).toMatchObject({ controlCount: 3, forward: { order: [0, 2], stop: "document-boundary" }, reverse: { order: [2, 0], stop: "document-boundary" }, unreachedControls: [1] });
  expect(f.press).toHaveBeenCalledTimes(5);
  expect(f.press).toHaveBeenNthCalledWith(1, "Tab");expect(f.press).toHaveBeenNthCalledWith(4, "Shift+Tab");
  expect(f.dispose).toHaveBeenCalledOnce();expect(JSON.stringify(result)).not.toContain("http://app");
});
it("reports repeats as incomplete observations, not a certified focus trap or a pass", async () => {
  const f = fixture([2, true, 0, 0, true, 0]);
  const result = await collectKeyboardOrder(f.page);
  expect(result.forward).toEqual({ order: [0], stop: "repeat" });expect(result.unreachedControls).toEqual([1]);
  expect(result).not.toHaveProperty("passed");expect(result).not.toHaveProperty("trap");
});
it.each([[-2, "nested-context"], [-3, "unmapped"], [false, "reset-unavailable"]])("retains unavailable scope %s", async (value, stop) => {
  const f = fixture(value === false ? [1, false, false] : [1, true, value, true, value]);
  expect((await collectKeyboardOrder(f.page)).forward).toEqual({ order: [], stop });
});
it("stops before inspecting a changed URL and does not probe its reverse sequence", async () => {
  const f = fixture([1, true], 1);
  const result = await collectKeyboardOrder(f.page);
  expect(result.forward.stop).toBe("navigation");expect(result.reverse.stop).toBe("navigation");
  expect(f.press).toHaveBeenCalledOnce();expect(f.evaluate).toHaveBeenCalledTimes(2);
});
it("keeps the step limit explicit instead of silently claiming all controls were probed", async () => {
  const sequence = Array.from({ length: defaults.keyboardProbeMaxSteps }, (_, i) => i);
  const f = fixture([defaults.keyboardProbeMaxSteps + 1, true, ...sequence, true, ...sequence]);
  const result = await collectKeyboardOrder(f.page);
  expect(result.forward.stop).toBe("step-limit");expect(result.reverse.stop).toBe("step-limit");expect(result.unreachedControls).toEqual([defaults.keyboardProbeMaxSteps]);
});
it.each([defaults.keyboardProbeMaxControls + 1, -1, "1"])("rejects invalid control counts %s and disposes handles", async count => {
  const f = fixture([count]);await expect(collectKeyboardOrder(f.page)).rejects.toThrow();expect(f.dispose).toHaveBeenCalledOnce();expect(f.press).not.toHaveBeenCalled();
});
it("propagates browser failure and still releases the DOM handle", async () => {
  const f = fixture([1, true]);f.press.mockRejectedValueOnce(new Error("Browser disconnected"));
  await expect(collectKeyboardOrder(f.page)).rejects.toThrow("Browser disconnected");expect(f.dispose).toHaveBeenCalledOnce();
});
it("filters disabled, hidden and inert candidates without reading private names or text", async () => {
  class Element {
    hidden = false; disabled = false; inert = false; visible = true;
    matches() { return this.disabled; } closest() { return this.inert ? this : null; } getClientRects() { return this.visible ? [{}] : []; }
  }
  const nodes = Array.from({ length: 5 }, () => new Element());
  Object.assign(nodes[1] ?? {}, { disabled: true });Object.assign(nodes[2] ?? {}, { hidden: true });Object.assign(nodes[3] ?? {}, { inert: true });Object.assign(nodes[4] ?? {}, { visible: false });
  vi.stubGlobal("HTMLElement", Element);vi.stubGlobal("document", { querySelectorAll: () => nodes });
  vi.stubGlobal("getComputedStyle", (element: Element) => ({ display: element.hidden ? "none" : "block", visibility: "visible" }));
  const f = fixture([1, true, -1, true, -1]);await collectKeyboardOrder(f.page);
  const callback = f.evaluateHandle.mock.calls[0]?.[0] as () => Element[];
  expect(callback()).toEqual([nodes[0]]);
});
it("validates control identities but keeps advisory keyboard evidence outside verifier comparisons", () => {
  const keyboard = { scope: "main-document-tab-order", controlCount: 1, forward: { order: [0], stop: "repeat" }, reverse: { order: [], stop: "reset-unavailable" }, unreachedControls: [] };
  expect(KeyboardProbeSchema.safeParse({ ...keyboard, unreachedControls: [1] }).success).toBe(false);
  const page = BrowserObservationSchema.parse({ route: "/", condition: "desktop-light", keyboard, violations: [], incomplete: [], aria: [], ariaTree: "", probeFailures: [], probeUnavailable: [], contexts: [], screenshot: "page.png", darkMediaDetected: false });
  expect(observationsToState([page])).toEqual({ violations: [], incomplete: [], aria: [], probeFailures: [] });
});
it.each([null, "5"])("restores the disposable body's original tabindex %s after resetting focus", async original => {
  const f = fixture([0, true, -1, true, -1]);await collectKeyboardOrder(f.page);
  let attribute: string | null = original;
  const document = { activeElement: null as unknown, body: { getAttribute: () => attribute,
    setAttribute: (_name: string, value: string) => { attribute = value; }, removeAttribute: () => { attribute = null; },
    focus: vi.fn(() => { document.activeElement = document.body; }) } };
  vi.stubGlobal("document", document);
  const reset = f.evaluate.mock.calls[1]?.[0] as () => boolean;
  expect(reset()).toBe(true);expect(attribute).toBe(original);expect(document.body.focus).toHaveBeenCalledWith({ preventScroll: true });
});
