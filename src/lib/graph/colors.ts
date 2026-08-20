/** CSS variables that own graph type color. Keep legend and cytoscape on this map. */
export const GRAPH_COLOR_VARS: Record<string, string> = {
  Paper: "--chart-1",
  Topic: "--chart-2",
  Method: "--chart-4",
  Entity: "--chart-3",
  Claim: "--chart-5",
  // The host theme may not define --chart-6..8; resolveGraphColors falls back
  // to the oklch values below, so legend swatches and node fills stay aligned.
  Dataset: "--chart-6",
  Gene: "--chart-7",
  Pathway: "--chart-8",
};

/**
 * Fallback fills when `document` is missing (unit tests). Values match the
 * dark-theme `--chart-*` tokens so screenshots and cytoscape stay aligned.
 */
export const GRAPH_COLORS: Record<string, string> = {
  Paper: "oklch(0.488 0.243 264.376)",
  Topic: "oklch(0.696 0.17 162.48)",
  Method: "oklch(0.627 0.265 303.9)",
  Entity: "oklch(0.769 0.188 70.08)",
  Claim: "oklch(0.645 0.246 16.439)",
  Dataset: "oklch(0.72 0.19 200)",
  Gene: "oklch(0.65 0.2 330)",
  Pathway: "oklch(0.68 0.16 85)",
};

const OKLCH_RE =
  /^oklch\(\s*([0-9.]+%?)\s+([0-9.]+)\s+(-?[0-9.]+)(?:\s*\/\s*([0-9.]+%?))?\s*\)$/i;

/**
 * Cytoscape's canvas parser does not accept `oklch()`. Convert theme tokens to
 * `rgb()` / `rgba()` so node fills match the legend swatches.
 */
export function paintForCanvas(cssColor: string): string {
  const value = cssColor.trim();
  if (!value) {
    return value;
  }
  if (/^#([0-9a-f]{3,8})$/i.test(value) || /^(?:rgba?|hsla?)\(/i.test(value)) {
    return value;
  }
  const match = OKLCH_RE.exec(value);
  if (!match) {
    return value;
  }
  const lightness = parseLightness(match[1]);
  const chroma = Number(match[2]);
  const hue = Number(match[3]);
  const alpha = match[4] === undefined ? 1 : parseAlpha(match[4]);
  const [r, g, b] = oklchToSrgb(lightness, chroma, hue);
  if (alpha < 1) {
    return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
  }
  return `rgb(${r}, ${g}, ${b})`;
}

/** Resolve live theme colors so the legend swatch and node fill are the same paint. */
export function resolveGraphColors(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [type, fallback] of Object.entries(GRAPH_COLORS)) {
    let value = fallback;
    if (typeof document !== "undefined") {
      const live = getComputedStyle(document.documentElement)
        .getPropertyValue(GRAPH_COLOR_VARS[type] ?? "")
        .trim();
      if (live) {
        value = live;
      }
    }
    out[type] = paintForCanvas(value);
  }
  return out;
}

function parseLightness(raw: string): number {
  if (raw.endsWith("%")) {
    return Number(raw.slice(0, -1)) / 100;
  }
  const value = Number(raw);
  return value > 1 ? value / 100 : value;
}

function parseAlpha(raw: string): number {
  if (raw.endsWith("%")) {
    return Number(raw.slice(0, -1)) / 100;
  }
  return Number(raw);
}

function oklchToSrgb(L: number, C: number, H: number): [number, number, number] {
  const hue = (H * Math.PI) / 180;
  const a = C * Math.cos(hue);
  const b = C * Math.sin(hue);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const rLin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [toByte(rLin), toByte(gLin), toByte(bLin)];
}

function toByte(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear));
  const encoded = clamped >= 0.0031308
    ? 1.055 * clamped ** (1 / 2.4) - 0.055
    : 12.92 * clamped;
  return Math.round(encoded * 255);
}
