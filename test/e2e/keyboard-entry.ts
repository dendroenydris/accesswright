import assert from "node:assert/strict";
import { chromium } from "playwright";
import { collectKeyboardOrder } from "../../src/scanner/keyboard.js";
import { assertContainerRuntime } from "../../src/runner/worker-boundary.js";

await assertContainerRuntime();
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent('<button>First</button><button>Second</button><div role="button">Pointer only</div><button disabled>Disabled</button><button hidden>Hidden</button>');
    const order = await collectKeyboardOrder(page);
    assert.equal(order.controlCount, 3);assert.deepEqual(order.forward.order, [0, 1]);assert.deepEqual(order.reverse.order, [1, 0]);assert.deepEqual(order.unreachedControls, [2]);
    assert.equal(order.forward.stop, "document-boundary");assert.equal(order.reverse.stop, "document-boundary");
    await page.close();const repeatPage = await context.newPage();
    await repeatPage.setContent('<button id="first">First</button><button>Second</button><script>document.addEventListener("keydown",event=>{if(event.key==="Tab"){event.preventDefault();document.getElementById("first").focus();}});</script>');
    const repeat = await collectKeyboardOrder(repeatPage);
    assert.equal(repeat.forward.stop, "repeat");assert.equal(repeat.reverse.stop, "repeat");assert.deepEqual(repeat.unreachedControls, [1]);
    await repeatPage.close();const navigationPage = await context.newPage();
    await navigationPage.setContent('<button onfocus="location.hash=\'moved\'">Focus navigation</button>');
    const navigation = await collectKeyboardOrder(navigationPage);assert.equal(navigation.forward.stop, "navigation");assert.equal(navigation.reverse.stop, "navigation");
    console.log(JSON.stringify({ kind: "real-isolated-keyboard-probe", cases: 3, forward: order.forward.order.length, reverse: order.reverse.order.length,
      unreached: order.unreachedControls.length, repeatedSequences: 2, navigationStopped: true, paid: 0 }));
  } finally { await context.close(); }
} finally { await browser.close(); }
