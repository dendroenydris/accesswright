import { converter, wcagContrast } from "culori";
import { describe, expect, it } from "vitest";

import {
  choosePaletteColor,
  contrastRatio,
  optimizeContrast,
} from "../../src/fixers/contrast.js";

const toOklch = converter("oklch");

describe("contrastRatio", () => {
  it("matches the WCAG black-on-white reference ratio", () => {
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 8);
  });
});

describe("optimizeContrast", () => {
  it("leaves an already-passing foreground unchanged", () => {
    expect(optimizeContrast("#555555", "#ffffff", 4.5)).toEqual({
      color: "#555555",
      contrast: wcagContrast("#555555", "#ffffff"),
      deltaE: 0,
    });
  });

  it("finds a passing color while preserving OKLCH hue", () => {
    const original = toOklch("#7aa7d8");
    const result = optimizeContrast("#7aa7d8", "#ffffff", 4.5);
    expect(result).not.toBeNull();
    expect(result?.contrast ?? 0).toBeGreaterThanOrEqual(4.5);

    const optimized = toOklch(result?.color ?? "#000000");
    expect(original).toBeDefined();
    expect(optimized).toBeDefined();
    if (original?.h !== undefined && optimized?.h !== undefined) {
      expect(Math.abs(original.h - optimized.h)).toBeLessThan(0.5);
    }
    expect(result?.deltaE ?? 0).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    expect(optimizeContrast("#7aa7d8", "#ffffff", 4.5)).toEqual(
      optimizeContrast("#7aa7d8", "#ffffff", 4.5),
    );
  });

  it("returns null when neither lightness direction can meet the target", () => {
    expect(optimizeContrast("#777777", "#777777", 7)).toBeNull();
  });

  it("rejects invalid colors at the boundary", () => {
    expect(() => optimizeContrast("not-a-color", "#ffffff", 4.5)).toThrow(/color/i);
  });
});

describe("choosePaletteColor", () => {
  it("chooses the perceptually closest palette color that passes", () => {
    expect(
      choosePaletteColor("#777777", "#ffffff", ["#777777", "#666666", "#555555"], 4.5),
    ).toMatchObject({
      color: "#666666",
    });
  });

  it("returns null when no palette color passes", () => {
    expect(
      choosePaletteColor("#aaaaaa", "#ffffff", ["#aaaaaa", "#bbbbbb"], 4.5),
    ).toBeNull();
  });
});
