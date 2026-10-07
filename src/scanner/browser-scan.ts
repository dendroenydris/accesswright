import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "playwright";
import { z } from "zod";
import { contrastRatio } from "../fixers/contrast.js";
import { isSourcePath } from "../types/schemas.js";
import { normalizeAxeResults } from "./scan.js";
import { extractSourceLocationFromHtml } from "./source-location.js";
import { mergeBrowserFacts } from "./browser-facts.js";
import type { BrowserAxFact, BrowserDomFact, ScanCondition } from "./browser-facts.js";
import { BrowserObservationSchema } from "./observations.js";
import type { BrowserObservation, RenderedContext } from "./observations.js";

interface DomNode {
  nodeId: number;
  backendNodeId: number;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
}
const DomNodeSchema: z.ZodType<DomNode> = z.lazy(() => z.object({
  nodeId: z.number(), backendNodeId: z.number(), attributes: z.array(z.string()).optional(),
  children: z.array(DomNodeSchema).optional(), shadowRoots: z.array(DomNodeSchema).optional(),
  contentDocument: DomNodeSchema.optional(),
}));
const valueSchema = z.object({ value: z.unknown().optional() });
const AxTreeSchema = z.object({ nodes: z.array(z.object({
  nodeId: z.string(), ignored: z.boolean(), backendDOMNodeId: z.number().optional(),
  role: valueSchema.optional(), name: valueSchema.optional(),
  properties: z.array(z.object({ name: z.string(), value: valueSchema })).optional(),
})) });
const ComputedStylesSchema = z.object({ computedStyle: z.array(z.object({ name: z.string(), value: z.string() })) });
const BackgroundSchema = z.object({ backgroundColors: z.array(z.string()).optional(), computedFontSize: z.string().optional(), computedFontWeight: z.string().optional() });

export interface BrowserScanOptions {
  route: string;
  condition: ScanCondition;
  generation: string;
  evidenceDir: string;
  interactionProbes?: boolean;
}

function findDomMarkers(root: DomNode): Map<string, { backend: number; nodeId: number }> {
  const markers = new Map<string, { backend: number; nodeId: number }>();
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.pop();
    if (node === undefined) break;
    const attrs = node.attributes ?? [];
    for (let index = 0; index < attrs.length - 1; index += 2) {
      if (attrs[index] === "data-accesswright-ref") {
        const marker = attrs[index + 1];
        if (marker !== undefined) markers.set(marker, { backend: node.backendNodeId, nodeId: node.nodeId });
      }
    }
    queue.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
    if (node.contentDocument) queue.push(node.contentDocument);
  }
  return markers;
}

export async function collectAccessibleFacts(page: Page, prefix: string, interactionProbes = true) {
  const dom: BrowserDomFact[] = await page.evaluate((prefixValue) => {
    function stableId(element: Element): string {
      if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${element.id}`;
      const path: number[] = [];
      let node: Element | null = element;
      while (node && node !== document.body) {
        const parent: HTMLElement | null = node.parentElement;
        if (!parent) break;
        path.unshift(Array.from(parent.children).indexOf(node));
        node = parent;
      }
      return `dom/${path.join("/")}`;
    }
    const elements = [document.body, ...document.body.querySelectorAll("*")].filter(element =>
      !element.closest("script,style,noscript,template,nextjs-portal,code-inspector-component") && !element.matches("link,meta"),
    );
    if (elements.length > 20000) throw new Error("Page exceeds the explicit accessibility-node limit");
    return elements.map((element, index) => {
      const marker = `aw${index}`;
      element.setAttribute("data-accesswright-ref", marker);
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      let transparent = false;
      for (let parent: Element | null = element; parent; parent = parent.parentElement) {
        if (getComputedStyle(parent).opacity === "0") transparent = true;
      }
      const text = Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
      const disabled = element.matches(":disabled,[aria-disabled='true']") || style.pointerEvents === "none";
      return {
        marker, id: `${prefixValue}|${stableId(element)}`, text,
        visible: !transparent && style.visibility !== "hidden" && style.visibility !== "collapse" && style.display !== "none" && (style.display === "contents" || rect.width > 0 || rect.height > 0),
        ariaHidden: element.closest("[aria-hidden='true'],[inert]") !== null,
        nativeInteractive: element.matches("button,input:not([type='hidden']),select,textarea,a[href],summary,[contenteditable='true']") || (element instanceof HTMLElement && element.tabIndex >= 0),
        disabled,
        protectedContent: element.tagName === "IMG" && element.getAttribute("alt") !== "",
      };
    });
  }, prefix);

  const client = await page.context().newCDPSession(page);
  try {
    await client.send("DOM.enable");
    await client.send("Accessibility.enable");
    const document = z.object({ root: DomNodeSchema }).parse(await client.send("DOM.getDocument", { depth: -1, pierce: true }));
    const markers = findDomMarkers(document.root);
    const tree = AxTreeSchema.parse(await client.send("Accessibility.getFullAXTree"));
    if (tree.nodes.length === 0 || (dom.length > 0 && markers.size === 0)) throw new Error("Browser accessibility facts are unavailable");
    const byBackend = new Map(tree.nodes.filter(node => node.backendDOMNodeId !== undefined).map(node => [node.backendDOMNodeId, node]));
    const ax: Record<string, BrowserAxFact> = {};
    for (const [marker, identity] of markers) {
      const node = byBackend.get(identity.backend);
      if (node === undefined) continue;
      const level = node.properties?.find(property => property.name === "level")?.value.value;
      ax[marker] = {
        ignored: node.ignored,
        role: typeof node.role?.value === "string" ? node.role.value : "generic",
        name: typeof node.name?.value === "string" ? node.name.value : "",
        focusable: node.properties?.some(property => property.name === "focusable" && property.value.value === true) ?? false,
        ...(typeof level === "number" && level > 0 ? { headingLevel: level } : {}),
      };
    }
    const aria = mergeBrowserFacts(dom, ax);
    const probeFailures: string[] = [], probeUnavailable: string[] = [];
    if (interactionProbes) {
      await client.send("CSS.enable");
      const interactiveIds = new Set(aria.filter(node => node.interactive).map(node => node.id));
      const controls = dom.filter(node => interactiveIds.has(node.id));
      if (controls.length > 150) throw new Error("Page exceeds the explicit interaction-probe limit");
      for (const control of controls) {
        const identity = markers.get(control.marker);
        if (!identity) throw new Error("An interactive browser node lost its DOM identity");
        const readStyle = async () => {
          const result = ComputedStylesSchema.parse(await client.send("CSS.getComputedStyleForNode", { nodeId: identity.nodeId }));
          return Object.fromEntries(result.computedStyle.map(property => [property.name, property.value]));
        };
        const baseline = await readStyle();
        try {
          await client.send("CSS.forcePseudoState", { nodeId: identity.nodeId, forcedPseudoClasses: ["focus", "focus-visible"] });
          const focus = await readStyle();
          const outline = Number.parseFloat(focus["outline-width"] ?? "0") > 0 && focus["outline-style"] !== "none";
          const shadow = focus["box-shadow"] !== undefined && focus["box-shadow"] !== "none";
          const changedBackground = focus["background-color"] !== baseline["background-color"];
          const changedBorder = focus["border-top-color"] !== baseline["border-top-color"] || focus["border-top-width"] !== baseline["border-top-width"];
          if (!outline && !shadow && !changedBackground && !changedBorder) probeFailures.push(`focus-style:${control.id}`);
          await client.send("CSS.forcePseudoState", { nodeId: identity.nodeId, forcedPseudoClasses: ["hover"] });
          const hover = await readStyle();
          const background = BackgroundSchema.parse(await client.send("CSS.getBackgroundColors", { nodeId: identity.nodeId }));
          const colors = background.backgroundColors;
          if (colors?.length === 1 && hover.color) {
            const target = Number.parseFloat(hover["font-size"] ?? "0") >= 24 || (Number.parseFloat(hover["font-size"] ?? "0") >= 18.66 && Number.parseFloat(hover["font-weight"] ?? "0") >= 700) ? 3 : 4.5;
            try { if (contrastRatio(hover.color, colors[0] ?? "") < target) probeFailures.push(`interaction-contrast:${control.id}`); }
            catch { probeUnavailable.push(`interaction-contrast:${control.id}`); }
          } else if (control.text.length > 0) probeUnavailable.push(`interaction-contrast:${control.id}`);
        } finally {
          await client.send("CSS.forcePseudoState", { nodeId: identity.nodeId, forcedPseudoClasses: [] });
        }
      }
    }
    return { aria, probeFailures, probeUnavailable };
  } finally { await client.detach(); }
}

async function renderedPalette(page: Page): Promise<{ palette: Array<{ className: string; color: string }>; darkMediaDetected: boolean }> {
  return page.evaluate(() => {
    const classes = new Set<string>();
    let darkMediaDetected = false;
    function visit(rules: CSSRuleList): void {
      for (const rule of rules) {
        if (rule.cssText.includes("prefers-color-scheme") && rule.cssText.includes("dark")) darkMediaDetected = true;
        if (rule instanceof CSSStyleRule && /^\.text-[a-zA-Z0-9_-]+$/.test(rule.selectorText)) classes.add(rule.selectorText.slice(1));
        if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
      }
    }
    for (const sheet of document.styleSheets) { try { visit(sheet.cssRules); } catch { /* Cross-origin sheets are not readable; their colors are not invented. */ } }
    const element = document.createElement("span");
    element.style.cssText = "position:fixed;left:-10000px;top:-10000px;visibility:hidden";
    element.setAttribute("aria-hidden", "true");
    document.body.append(element);
    const palette = Array.from(classes).slice(0, 512).map(className => { element.className = className; return { className, color: getComputedStyle(element).color }; });
    element.remove();
    return { palette, darkMediaDetected };
  });
}

export async function scanBrowserPage(page: Page, options: BrowserScanOptions): Promise<BrowserObservation> {
  if (!/^[a-zA-Z0-9_-]+$/.test(options.generation)) throw new Error("Invalid evidence generation name");
  await mkdir(options.evidenceDir, { recursive: true });
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
  const palette = await renderedPalette(page);
  let builder = new AxeBuilder({ page }).exclude("nextjs-portal").exclude("code-inspector-component");
  if (options.condition === "mobile-light") builder = builder.withRules(["target-size"]);
  if (options.condition === "desktop-dark") builder = builder.withRules(["color-contrast"]);
  const analyzed = normalizeAxeResults(options.route, await builder.analyze());
  const violations = analyzed.violations.map(item => ({ ...item, condition: options.condition }));
  const incomplete = analyzed.incomplete.map(item => ({ ...item, condition: options.condition }));
  const facts = await collectAccessibleFacts(page, `${options.route}|${options.condition}`, options.interactionProbes ?? true);
  const hash = createHash("sha256").update(`${options.route}|${options.condition}`).digest("hex").slice(0, 12);
  const base = `${options.generation}-${hash}`;
  const screenshot = `${base}-page.png`;
  await page.screenshot({ path: join(options.evidenceDir, screenshot), fullPage: true, animations: "disabled", caret: "hide" });
  const contexts: RenderedContext[] = [];
  const title = await page.title();
  for (const [index, violation] of violations.entries()) {
    const locator = page.locator(violation.target.join(" >> ")).first();
    try {
      const context = await locator.evaluate(element => {
        const parents: string[] = [];
        for (let node: Element | null = element; node; node = node.parentElement) {
          if (node.hasAttribute("data-insp-path")) parents.push(node.outerHTML.slice(0, 16000));
        }
        const style = getComputedStyle(element);
        let background: string | null = null;
        for (let node: Element | null = element; node; node = node.parentElement) {
          const current = getComputedStyle(node);
          if (current.backgroundImage !== "none") break;
          if (current.backgroundColor !== "rgba(0, 0, 0, 0)" && current.backgroundColor !== "transparent") { background = current.backgroundColor; break; }
        }
        const figure = element.closest("figure");
        const caption = figure?.querySelector("figcaption")?.textContent?.trim() ?? null;
        const anchor = element.closest("a");
        return {
          parents, direct: element.hasAttribute("data-insp-path"), surroundingText: (element.parentElement?.textContent ?? "").trim().slice(0, 3000),
          imageCaption: caption?.slice(0, 1000) ?? null, linkTarget: anchor?.getAttribute("href") ?? null,
          foreground: style.color, background,
          contrastTarget: Number.parseFloat(style.fontSize) >= 24 || (Number.parseFloat(style.fontSize) >= 18.66 && Number.parseFloat(style.fontWeight) >= 700) ? 3 : 4.5,
        };
      });
      const mapped = context.parents.map(html => extractSourceLocationFromHtml(html)).find(source => source !== null && isSourcePath(source.file)) ?? null;
      const direct = context.direct && context.parents[0] !== undefined && extractSourceLocationFromHtml(context.parents[0])?.file === mapped?.file;
      if (mapped !== null) violation.source = mapped;
      let crop: string | null = null;
      if (await locator.isVisible()) {
        crop = `${base}-target-${index}.png`;
        await locator.screenshot({ path: join(options.evidenceDir, crop), animations: "disabled", caret: "hide", timeout: 10000 });
      }
      contexts.push({ target: violation.target, source: mapped, mapping: mapped === null ? "unmapped" : direct ? "direct" : "ancestor", pageTitle: title,
        surroundingText: context.surroundingText, imageCaption: context.imageCaption, linkTarget: context.linkTarget,
        screenshot: crop, foreground: context.foreground, background: context.background, contrastTarget: context.contrastTarget, palette: palette.palette });
    } catch {
      // Missing/iframe targets remain explicitly unmapped; the planner cannot auto-fix them.
      violation.source = null;
      contexts.push({ target: violation.target, source: null, mapping: "unmapped", pageTitle: title, surroundingText: "", imageCaption: null, linkTarget: null,
        screenshot: null, foreground: "", background: null, contrastTarget: 4.5, palette: [] });
    }
  }
  const sourceAttributes = await page.locator("[data-insp-path]").evaluateAll(elements => elements.map(element => ({
    path: element.getAttribute("data-insp-path"), row: element.getAttribute("data-insp-row"), column: element.getAttribute("data-insp-col"),
  })));
  const sourceFiles = [...new Set(sourceAttributes.map(attributes => {
    // Inspector coordinates are metadata, not a document to execute. Quote escaping preserves the existing parser boundary.
    const escaped = (value: string) => value.replaceAll('"', "&quot;");
    const html = `<div data-insp-path="${escaped(attributes.path ?? "")}" data-insp-row="${escaped(attributes.row ?? "")}" data-insp-col="${escaped(attributes.column ?? "")}">`;
    return extractSourceLocationFromHtml(html)?.file;
  }).filter((file): file is string => file !== undefined && isSourcePath(file)))].sort();
  return BrowserObservationSchema.parse({ route: options.route, condition: options.condition, violations, incomplete,
    ...facts, sourceFiles, ariaTree: await page.locator("body").ariaSnapshot(), contexts, screenshot, darkMediaDetected: palette.darkMediaDetected });
}
