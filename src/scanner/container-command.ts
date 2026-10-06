import { z } from "zod";

const baseUrlSchema = z
  .string()
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "baseUrl must use http or https",
  });

const crawlOptionsSchema = z.object({
  maxDepth: z.number().int().min(0).max(10),
  maxPages: z.number().int().min(1).max(50),
});

const routeSchema = z
  .string()
  .startsWith("/")
  .refine((value) => !value.startsWith("//"), { message: "route must be same-origin relative" });

const scanRoutesSchema = z.array(routeSchema).min(1).max(50);

export type ContainerCommand =
  | { kind: "crawl"; baseUrl: string; maxDepth: number; maxPages: number }
  | { kind: "scan"; baseUrl: string; routes: string[]; screenshotDir: string };

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error("Invalid JSON argument", { cause: error });
  }
}

export function parseContainerCommand(args: readonly string[]): ContainerCommand {
  const kind = args[0];
  if (kind === "crawl") {
    if (args.length !== 3 || args[1] === undefined || args[2] === undefined) {
      throw new Error("crawl requires baseUrl and options JSON");
    }
    const baseUrl = baseUrlSchema.parse(args[1]);
    const options = crawlOptionsSchema.parse(parseJson(args[2]));
    return { kind, baseUrl, ...options };
  }

  if (kind === "scan") {
    if (
      args.length !== 4 ||
      args[1] === undefined ||
      args[2] === undefined ||
      args[3] === undefined
    ) {
      throw new Error("scan requires baseUrl, routes JSON, and screenshot directory");
    }
    return {
      kind,
      baseUrl: baseUrlSchema.parse(args[1]),
      routes: scanRoutesSchema.parse(parseJson(args[2])),
      screenshotDir: z.string().min(1).parse(args[3]),
    };
  }

  throw new Error(`Unknown container scanner command: ${kind ?? "<missing>"}`);
}
