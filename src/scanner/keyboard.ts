import type { Page } from "playwright";
import { z } from "zod";
import { defaults } from "../config.js";

const index = z.number().int().min(0).max(defaults.keyboardProbeMaxControls - 1);
const direction = z.object({
  order: z.array(index).max(defaults.keyboardProbeMaxSteps),
  stop: z.enum(["document-boundary", "repeat", "step-limit", "unmapped", "nested-context", "navigation", "reset-unavailable"]),
}).strict();
export const KeyboardProbeSchema = z.object({
  scope: z.literal("main-document-tab-order"),
  controlCount: z.number().int().nonnegative().max(defaults.keyboardProbeMaxControls),
  forward: direction, reverse: direction,
  unreachedControls: z.array(index).max(defaults.keyboardProbeMaxControls),
}).strict().refine(result => [...result.forward.order, ...result.reverse.order, ...result.unreachedControls].every(id => id < result.controlCount), "Unknown keyboard control index");
export type KeyboardProbe = z.infer<typeof KeyboardProbeSchema>;

/** Use a disposable page: focus handlers can change application state even without clicking. */
export async function collectKeyboardOrder(page: Page): Promise<KeyboardProbe> {
  const url = page.url();
  const controls = await page.evaluateHandle(() => Array.from(document.querySelectorAll(
    "button,input:not([type='hidden']),select,textarea,a[href],summary,[contenteditable='true'],[tabindex],[role='button'],[role='link'],[role='checkbox'],[role='radio'],[role='switch'],[role='tab'],[role='textbox'],[role='combobox'],[role='menuitem'],[role='slider']",
  )).filter((element): element is HTMLElement => {
    if (!(element instanceof HTMLElement) || element.matches(":disabled,[aria-disabled='true']") || element.closest("[inert],[aria-hidden='true']")) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && element.getClientRects().length > 0;
  }));
  try {
    const count = z.number().int().nonnegative().max(defaults.keyboardProbeMaxControls).parse(await controls.evaluate(elements => elements.length));
    const walk = async (key: "Tab" | "Shift+Tab", startAt?: number): Promise<z.infer<typeof direction>> => {
      const order: number[] = [];
      if (startAt === undefined) {
        const reset = await controls.evaluate(() => {
          const body = document.body, original = body.getAttribute("tabindex");
          try { body.setAttribute("tabindex", "-1"); body.focus({ preventScroll: true }); return document.activeElement === body; }
          finally { if (original === null) body.removeAttribute("tabindex"); else body.setAttribute("tabindex", original); }
        });
        if (!z.boolean().parse(reset)) return { order, stop: "reset-unavailable" };
      } else {
        const focused = await controls.evaluate((elements, id) => {
          const target = elements[id];
          if (target === undefined || !target.isConnected) return false;
          target.focus({ preventScroll: true });
          return document.activeElement === target;
        }, startAt);
        if (page.url() !== url) return { order, stop: "navigation" };
        if (!z.boolean().parse(focused)) return { order, stop: "reset-unavailable" };
        order.push(startAt);
      }
      for (let step = order.length; step < defaults.keyboardProbeMaxSteps; step++) {
        await page.keyboard.press(key);
        if (page.url() !== url) return { order, stop: "navigation" };
        const focused = z.number().int().min(-3).max(defaults.keyboardProbeMaxControls - 1).parse(await controls.evaluate(elements => {
          const active = document.activeElement;
          if (active === null || active === document.body || active === document.documentElement) return -1;
          // shortcut: nested browsing contexts need a separate probe; never claim their keyboard coverage here.
          if (active.tagName === "IFRAME" || active.tagName === "FRAME" || active.shadowRoot !== null) return -2;
          const id = elements.indexOf(active as HTMLElement);
          return id < 0 || !active.isConnected ? -3 : id;
        }));
        if (focused === -1) return { order, stop: "document-boundary" };
        if (focused === -2) return { order, stop: "nested-context" };
        if (focused === -3 || focused >= count) return { order, stop: "unmapped" };
        if (order.includes(focused)) return { order, stop: "repeat" };
        order.push(focused);
      }
      return { order, stop: "step-limit" };
    };
    const forward = await walk("Tab"), lastForwardControl = forward.order.at(-1);
    const reverse = page.url() !== url ? { order: [], stop: "navigation" as const } :
      lastForwardControl === undefined ? { order: [], stop: "reset-unavailable" as const } : await walk("Shift+Tab", lastForwardControl);
    const reached = new Set([...forward.order, ...reverse.order]);
    return KeyboardProbeSchema.parse({ scope: "main-document-tab-order", controlCount: count, forward, reverse,
      unreachedControls: Array.from({ length: count }, (_, id) => id).filter(id => !reached.has(id)) });
  } finally { await controls.dispose(); }
}
