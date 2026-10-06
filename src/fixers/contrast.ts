import {
  converter,
  differenceCiede2000,
  formatHex,
  inGamut,
  parse,
  wcagContrast,
} from "culori";
import type { Color, Oklch } from "culori";

export interface ContrastOptimization {
  color: string;
  contrast: number;
  deltaE: number;
}

const toOklch = converter("oklch");
const isRgb = inGamut("rgb");
const deltaE2000 = differenceCiede2000();

function requireColor(value: string): Color {
  const parsed = parse(value);
  if (parsed === undefined) {
    throw new Error(`Invalid color: ${value}`);
  }
  return parsed;
}

function toHex(color: Color): string {
  const formatted = formatHex(color);
  if (formatted === undefined) {
    throw new Error("Unable to format color");
  }
  return formatted.toLowerCase();
}

function fitChromaToRgb(color: Oklch): Oklch {
  if (isRgb(color)) return color;

  const gray: Oklch = { ...color, c: 0 };
  if (!isRgb(gray) || color.c <= 0) return gray;

  let low = 0;
  let high = color.c;
  let best = gray;

  for (let iteration = 0; iteration < 28; iteration += 1) {
    const midpoint = (low + high) / 2;
    const candidate: Oklch = { ...color, c: midpoint };
    if (isRgb(candidate)) {
      low = midpoint;
      best = candidate;
    } else {
      high = midpoint;
    }
  }

  return best;
}

function evaluateCandidate(
  original: Color,
  background: Color,
  candidate: Oklch,
  target: number,
): ContrastOptimization | null {
  const fitted = fitChromaToRgb(candidate);
  const color = toHex(fitted);
  const contrast = wcagContrast(color, background);
  if (contrast + Number.EPSILON < target) return null;

  return {
    color,
    contrast,
    deltaE: deltaE2000(original, color),
  };
}

function searchLightnessDirection(
  original: Color,
  originalOklch: Oklch,
  background: Color,
  endpoint: 0 | 1,
  target: number,
): ContrastOptimization | null {
  const endpointResult = evaluateCandidate(
    original,
    background,
    { ...originalOklch, l: endpoint },
    target,
  );
  if (endpointResult === null) return null;

  let failingLightness = originalOklch.l;
  let passingLightness: number = endpoint;
  let best = endpointResult;

  for (let iteration = 0; iteration < 36; iteration += 1) {
    const midpoint = (failingLightness + passingLightness) / 2;
    const result = evaluateCandidate(
      original,
      background,
      { ...originalOklch, l: midpoint },
      target,
    );

    if (result === null) {
      failingLightness = midpoint;
    } else {
      passingLightness = midpoint;
      best = result;
    }
  }

  return best;
}

function normalizedColor(value: string): { parsed: Color; hex: string } {
  const parsed = requireColor(value);
  return { parsed, hex: toHex(parsed) };
}

export function contrastRatio(foreground: string, background: string): number {
  const fg = requireColor(foreground);
  const bg = requireColor(background);
  return wcagContrast(fg, bg);
}

export function optimizeContrast(
  foreground: string,
  background: string,
  target = 4.5,
): ContrastOptimization | null {
  if (!Number.isFinite(target) || target < 1) {
    throw new Error(`Invalid contrast target: ${target}`);
  }

  const original = normalizedColor(foreground);
  const bg = normalizedColor(background);
  const currentContrast = wcagContrast(original.parsed, bg.parsed);

  if (currentContrast >= target) {
    return {
      color: original.hex,
      contrast: currentContrast,
      deltaE: 0,
    };
  }

  const originalOklch = toOklch(original.parsed);
  if (originalOklch === undefined) {
    throw new Error(`Unable to convert color to OKLCH: ${foreground}`);
  }

  const candidates = [
    searchLightnessDirection(original.parsed, originalOklch, bg.parsed, 0, target),
    searchLightnessDirection(original.parsed, originalOklch, bg.parsed, 1, target),
  ].filter((candidate): candidate is ContrastOptimization => candidate !== null);

  if (candidates.length === 0) return null;

  candidates.sort((left, right) => {
    const byDifference = left.deltaE - right.deltaE;
    if (Math.abs(byDifference) > 1e-12) return byDifference;
    return left.color.localeCompare(right.color);
  });

  return candidates[0] ?? null;
}

export function choosePaletteColor(
  foreground: string,
  background: string,
  palette: readonly string[],
  target = 4.5,
): ContrastOptimization | null {
  if (!Number.isFinite(target) || target < 1) {
    throw new Error(`Invalid contrast target: ${target}`);
  }

  const original = normalizedColor(foreground);
  const bg = normalizedColor(background);
  const candidates: Array<ContrastOptimization & { index: number }> = [];

  for (const [index, paletteColor] of palette.entries()) {
    const candidate = normalizedColor(paletteColor);
    const contrast = wcagContrast(candidate.parsed, bg.parsed);
    if (contrast < target) continue;

    candidates.push({
      color: candidate.hex,
      contrast,
      deltaE: deltaE2000(original.parsed, candidate.parsed),
      index,
    });
  }

  candidates.sort((left, right) => {
    const byDifference = left.deltaE - right.deltaE;
    if (Math.abs(byDifference) > 1e-12) return byDifference;
    return left.index - right.index;
  });

  const best = candidates[0];
  if (best === undefined) return null;

  return {
    color: best.color,
    contrast: best.contrast,
    deltaE: best.deltaE,
  };
}
