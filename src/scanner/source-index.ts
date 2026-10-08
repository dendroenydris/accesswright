import type { Page } from "playwright";
import { z } from "zod";
import { isSourcePath, SourceLocationSchema } from "../types/schemas.js";
import { extractSourceLocationFromAttributes } from "./source-location.js";

const annotationSchema = z.object({ path: z.string().nullable(), row: z.string().nullable(), column: z.string().nullable(), depth: z.number().int().nonnegative() }).strict();
const rawEntrySchema = z.object({ nodeId: z.string(), selector: z.string(), tagName: z.string(), visible: z.boolean(), annotations: z.array(annotationSchema).max(32) }).strict();
export const SourceIndexEntrySchema = z.object({ nodeId: z.string(), target: z.array(z.string()).min(1), tagName: z.string(), mapping: z.enum(["direct", "ancestor"]), source: SourceLocationSchema }).strict();
export type SourceIndexEntry = z.infer<typeof SourceIndexEntrySchema>;

export function normalizeSourceIndex(input: unknown): SourceIndexEntry[] {
  const entries = z.array(rawEntrySchema).max(20000).parse(input);
  const result: SourceIndexEntry[] = [];
  for (const entry of entries) {
    if (!entry.visible) continue;
    for (const annotation of entry.annotations) {
      const source = extractSourceLocationFromAttributes(annotation.path, annotation.row, annotation.column);
      if (!source || !isSourcePath(source.file)) continue;
      result.push({ nodeId: entry.nodeId, target: [entry.selector], tagName: entry.tagName, mapping: annotation.depth === 0 ? "direct" : "ancestor", source });
      break;
    }
  }
  return result;
}

/** Index clean as well as violating rendered elements; no source HTML is returned. */
export async function collectSourceIndex(page: Page, prefix: string): Promise<SourceIndexEntry[]> {
  const raw = await page.evaluate(prefixValue => {
    const elements = [document.documentElement, document.body, ...document.body.querySelectorAll("*")].filter(element => !element.closest("script,style,noscript,template,nextjs-portal,code-inspector-component") && !element.matches("link,meta"));
    if (elements.length > 20000) throw new Error("Rendered source index exceeds its node limit");
    return elements.map(element => {
      const uniqueId = element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1 ? element.id : null;
      const offsets: number[] = [], selectors: string[] = [];
      for (let node: Element | null = element; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        const parent: HTMLElement | null = node.parentElement;
        if (!parent) break;
        const offset = Array.from(parent.children).indexOf(node);
        offsets.unshift(offset);
        selectors.unshift(`${node.tagName.toLowerCase()}:nth-child(${offset + 1})`);
      }
      // Keep this fallback identical to collectAccessibleFacts; the integration test compares their identities.
      const identity = uniqueId ? `#${uniqueId}` : element === document.documentElement ? "html" : `dom/${offsets.join("/")}`;
      const selector = uniqueId ? `#${CSS.escape(uniqueId)}` : element === document.documentElement ? "html" : ["body", ...selectors].join(" > ");
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      let transparent = false;
      for (let node: Element | null = element; node; node = node.parentElement) if (getComputedStyle(node).opacity === "0") transparent = true;
      const visible = !transparent && element.closest("[aria-hidden='true'],[inert]") === null && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && (style.display === "contents" || rect.width > 0 || rect.height > 0);
      const annotations: Array<{ path: string | null; row: string | null; column: string | null; depth: number }> = [];
      let depth = 0;
      for (let node: Element | null = element; node && annotations.length < 32; node = node.parentElement, depth += 1) {
        if (node.hasAttribute("data-insp-path")) annotations.push({ path: node.getAttribute("data-insp-path"), row: node.getAttribute("data-insp-row"), column: node.getAttribute("data-insp-col"), depth });
      }
      return { nodeId: `${prefixValue}|${identity}`, selector, tagName: element.tagName.toLowerCase(), visible, annotations };
    });
  }, prefix);
  return normalizeSourceIndex(raw);
}
