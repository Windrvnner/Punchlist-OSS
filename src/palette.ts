/**
 * Every color of the app, worked out from the control file's three base colors (colors.neutral, colors.accent,
 * colors.red), so changing one base recolors its whole family in both themes: red to blue turns the light red tint
 * into a light blue one too. The neutral is a cool slate gray in both themes.
 *
 * How: each token below says which base it comes from and how light it is in each theme. It takes the base's hue and
 * strength (chroma, in OKLCH, a color space where equal steps of lightness look equal) at that lightness, so a token
 * stays as light or dark as it must be for its role whatever base is set, and text stays readable. Pure white and
 * black (the glass's light and the shadows in dark) have no hue to take, so they stay as they are.
 *
 * The build writes the result ahead of src/styles.css (`colorCss`, see vite.config.ts), and the deal memo prints in the
 * light theme's colors (`themeColors`). `paletteProblems` checks that text stays readable on what it sits on, and the
 * build stops if it does not. Windows High Contrast takes the system's colors whatever is set (src/styles.css).
 */
import { control, type Control } from './control';

export type Theme = 'dark' | 'light';
type Base = 'neutral' | 'accent' | 'red';

// ---- color math: sRGB hex <-> OKLCH (Björn Ottosson's OKLab, https://bottosson.github.io/posts/oklab/) ---------------

type Rgb = [number, number, number];   // 0 to 1 each
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const hexRgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;

/** a hex color's OKLCH: lightness 0 to 1, chroma (0 is gray), hue in degrees */
export function oklch(hex: string): [number, number, number] {
  const [r, g, b] = hexRgb(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

/** OKLCH to linear sRGB, which may fall outside 0 to 1 when the color cannot be shown */
function linearRgb(L: number, C: number, H: number): Rgb {
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/** OKLCH as a hex color; a chroma the screen cannot show is lowered until it can, keeping the lightness and hue */
function hexOf(L: number, C: number, H: number): string {
  const fits = (c: number) => linearRgb(L, c, H).every((v) => v >= -1e-6 && v <= 1 + 1e-6);
  if (!fits(C)) { let lo = 0, hi = C; for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; } C = lo; }
  return '#' + linearRgb(L, C, H).map((v) => Math.round(fromLinear(Math.min(1, Math.max(0, v))) * 255).toString(16).padStart(2, '0')).join('');
}

/** WCAG relative luminance and contrast ratio (1 to 21) of two hex colors */
const luminance = (hex: string) => { const [r, g, b] = hexRgb(hex).map(toLinear); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (x: string, y: string) => { const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p); return (a + 0.05) / (b + 0.05); };

// ---- the tokens: each one's base, and its lightness (and see-through alpha) in each theme -----------------------------

/** a token's color: its base (or plain white or black), OKLCH lightness 0 to 1, alpha 0 to 1, and its chroma as a share of the base's */
interface Paint { base: Base | 'white' | 'black'; L: number; alpha: number; chroma: number }
const n = (L: number, alpha = 1, chroma = 0.7): Paint => ({ base: 'neutral', L, alpha, chroma });
const a = (L: number, alpha = 1, chroma = 1): Paint => ({ base: 'accent', L, alpha, chroma });
const r = (L: number, alpha = 1, chroma = 1): Paint => ({ base: 'red', L, alpha, chroma });
const W = (alpha = 1): Paint => ({ base: 'white', L: 1, alpha, chroma: 0 });
const K = (alpha = 1): Paint => ({ base: 'black', L: 0, alpha, chroma: 0 });
/** a shadow: one or more layers, each its lengths and its paint */
type Shadow = [string, Paint][];
type Token = Paint | Shadow;
/** the light theme's shadows and overlays are a dark of the neutral rather than black */
const ls = (alpha: number) => n(0.299, alpha, 1.7);

/**
 * Every color token of the app by its name in src/styles.css (--accent and so on): [dark, light].
 * The lightness of each was taken from the hand-set colors it replaces, so the defaults look as before: the dark theme's
 * slate background, menus, tables and glass to within one step of 255 on each channel.
 * The `-soft` tints and other blends in src/styles.css and src/ui/ui.css are mixed from these, so they follow too.
 */
const TOKENS = {
  // background, text in three strengths, the accent and the text on it, red, the document page, notices, a turned-off button;
  // the accent (and the glow it lights) is a gray of the neutral in both themes, light in the dark one and graphite in the
  // light one, so both are black and white; colors.accent sets only the document page's highlight and mark (#873)
  surface: [n(0.172, 1, 0.66), n(0.916, 1, 0.9)], ink: [n(0.937, 1, 0.4), n(0.222)], 'ink-2': [n(0.736), n(0.474)], 'ink-3': [n(0.673, 1, 0.77), n(0.484, 1, 0.8)],
  accent: [n(0.831, 1, 1), n(0.3, 1, 1.28)], 'accent-ink': [n(0.196, 1, 0.25), W()], high: [r(0.722, 1, 0.74), r(0.502)],
  paper: [n(0.959, 1, 0.3), n(0.994, 1, 0.3)], 'paper-ink': [n(0.226), n(0.226)], toast: [n(0.937, 1, 0.4), n(0.222)], 'toast-ink': [n(0.178, 1, 0), W()], off: [n(0.937, 1, 0.4), n(0.222)],
  // the lit surface behind the glass, the glass, and the cards, menus and tables on it
  'light-a': [n(0.827, 0.16, 0.9), W(0.9)], 'light-b': [n(0.665, 0.14, 7.15), n(0.843, 0.55)], 'light-c': [W(0.05), n(0.848, 0.35, 1.6)],
  glass: [W(0.055), W(0.5)], 'glass-2': [W(0.085), W(0.66)], 'glass-solid': [n(0.217, 0.78, 0.61), W(0.8)], 'glass-edge': [W(0.13), W(0.85)],
  'glass-sheen': [W(0.07), W(0.6)], spec: [W(0.32), W()], card: [W(0.04), W(0.45)], 'card-edge': [W(0.09), n(0.275, 0.08, 0.65)], 'card-hover': [W(0.07), W(0.7)],
  menu: [n(0.226, 0.97, 0.81), W(0.97)], 'menu-solid': [n(0.226, 1, 0.81), n(0.988, 1, 0.1)], capsule: [n(0.217, 0.84, 0.61), W(0.86)], 'th-bg': [n(0.204, 1, 0.61), n(0.952, 1, 0.8)],
  'row-alt': [n(0.229, 1, 0.87), n(0.958)], 'option-bg': [W(), W()], 'option-ink': [n(0.178, 1, 0), n(0.178, 1, 0)], 'inset-edge': [K(0.08), K(0.04)],
  // lines and marks
  line: [W(0.08), n(0.234, 0.09, 0.65)], tick: [W(0.18), n(0.234, 0.22, 0.65)], dash: [W(0.2), n(0.234, 0.2, 0.65)], 'dash-bg': [W(0.02), W(0.35)],
  'bar-track': [W(0.1), n(0.234, 0.08, 0.65)], 'bar-ix': [W(0.28), n(0.234, 0.22, 0.65)], sweep: [W(0.4), W(0.75)], 'sweep-soft': [W(0.26), W(0.55)],
  // a document's page in reading mode; its highlight and mark take the accent
  'paper-2': [n(0.931, 1, 1), n(0.931, 1, 1)], 'paper-ink-2': [n(0.46, 1, 1), n(0.46, 1, 1)], 'paper-muted': [n(0.535, 1, 0.5), n(0.55, 1, 0.5)],
  'paper-faint': [n(0.627, 1, 0.5), n(0.627, 1, 0.5)], 'paper-grid': [n(0.873, 1, 1.3), n(0.889, 1, 1.3)], 'paper-rule': [n(0.898, 1, 0.5), n(0.898, 1, 0.5)],
  'paper-hl': [a(0.913, 1, 1.5), a(0.933, 1, 1.7)], 'paper-mark': [a(0.62, 1, 2.4), a(0.62, 1, 2.4)], 'paper-edge': [K(0.06), K(0.06)],
  'paper-shadow': [[['0 20px 50px', K(0.25)]], [['0 20px 50px', ls(0.2)]]],
  // what dims the page behind a dialog, and the shadows
  scrim: [K(0.45), n(0.269, 0.35, 1)], 'scrim-soft': [K(0.35), n(0.269, 0.25, 1)],
  shadow: [[['0 20px 60px', K(0.45)], ['0 2px 6px', K(0.3)]], [['0 20px 50px', ls(0.16)], ['0 2px 6px', ls(0.08)]]],
  'shadow-pop': [[['0 14px 40px', K(0.4)]], [['0 14px 40px', ls(0.18)]]], 'shadow-page': [[['0 30px 70px', K(0.45)]], [['0 30px 70px', ls(0.22)]]],
  'shadow-dlg': [[['0 40px 100px', K(0.6)]], [['0 40px 100px', ls(0.28)]]],
  // on a dark room a white page reads as lit: a hairline and a soft warm glow give it its depth
  'shadow-sheet': [[['0 0 0 1px', W(0.18)], ['0 0 36px', a(0.96, 0.1, 0.75)], ['0 0 150px', a(0.96, 0.2, 0.75)], ['0 26px 70px', K(0.7)]], [['0 0 0 1px', ls(0.07)], ['0 30px 70px', ls(0.22)]]],
} satisfies Record<string, [Token, Token]>;
export type ColorName = keyof typeof TOKENS;
export const COLOR_NAMES = Object.keys(TOKENS) as ColorName[];

// ---- working the colors out --------------------------------------------------------------------------------------------

/** a paint as CSS: #rrggbb when solid, rgba() when see-through */
function css(p: Paint, bases: Control['colors']): string {
  const hex = p.base === 'white' ? '#ffffff' : p.base === 'black' ? '#000000' : (() => { const [, C, H] = oklch(bases[p.base]); return hexOf(p.L, C * p.chroma, H); })();
  if (p.alpha >= 1) return hex;
  const [R, G, B] = hexRgb(hex).map((v) => Math.round(v * 255));
  return `rgba(${R},${G},${B},${+p.alpha.toFixed(3)})`;
}
const isShadow = (t: Token): t is Shadow => Array.isArray(t);

/** every token's CSS value in one theme, from the control file's base colors */
export function themeColors(theme: Theme, values: Control = control): Record<ColorName, string> {
  const i = theme === 'dark' ? 0 : 1;
  return Object.fromEntries(COLOR_NAMES.map((name) => {
    const t: Token = TOKENS[name][i];
    return [name, isShadow(t) ? t.map(([len, p]) => `${len} ${css(p, values.colors)}`).join(',') : css(t, values.colors)];
  })) as Record<ColorName, string>;
}

/** a solid color laid over another (for see-through tokens), as hex */
const over = (top: string, under: string): string => {
  const m = top.match(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/); if (!m) return top;
  const u = hexRgb(under).map((v) => v * 255), alpha = Number(m[4]);
  return '#' + [1, 2, 3].map((k, j) => Math.round(Number(m[k]) * alpha + u[j] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
};

/** text and marks, the backgrounds they sit on, and the contrast each must keep (WCAG 2.1 AA: 4.5 for text, 3 for marks and bars) */
const PAIRS: [ColorName, ColorName[], number][] = [
  ['ink', ['surface', 'menu-solid', 'th-bg', 'row-alt'], 4.5], ['ink-2', ['surface', 'menu-solid', 'th-bg', 'row-alt'], 4.5], ['ink-3', ['surface', 'menu-solid', 'th-bg'], 4.5],
  ['accent', ['surface', 'menu-solid'], 4.5], ['accent-ink', ['accent'], 4.5], ['high', ['surface', 'menu-solid'], 4.5],
  ['toast-ink', ['toast'], 4.5], ['paper-ink', ['paper', 'paper-2'], 4.5], ['paper-ink-2', ['paper'], 4.5], ['paper-muted', ['paper'], 4.5],
  ['paper-ink', ['paper-hl'], 4.5], ['paper-mark', ['paper'], 3], ['option-ink', ['option-bg'], 4.5],
];

/**
 * What is wrong with the base colors, one line each: empty when fine. Text must stay readable on what it sits on in
 * both themes, and the accent and red must be colors, not grays, and far enough apart in hue that "in progress" and
 * "needs you" never look alike (never two shades of one color meaning different things).
 */
export function paletteProblems(values: Control = control): string[] {
  const out: string[] = [];
  const hex = /^#[0-9a-f]{6}$/i;
  for (const b of ['neutral', 'accent', 'red'] as const) if (typeof values.colors?.[b] !== 'string' || !hex.test(values.colors[b])) out.push(`colors.${b} must be a hex color like #2e4a63.`);
  if (out.length) return out;
  const [, ca, ha] = oklch(values.colors.accent), [, cr, hr] = oklch(values.colors.red);
  for (const [b, c] of [['accent', ca], ['red', cr]] as const) if (c < 0.03) out.push(`colors.${b} is too close to a gray: pick a stronger color.`);
  if (oklch(values.colors.neutral)[1] > 0.05) out.push('colors.neutral is too colorful for backgrounds and text: pick a gray, or a gray with a slight tint.');
  const apart = Math.min(Math.abs(ha - hr), 360 - Math.abs(ha - hr));
  if (ca >= 0.03 && cr >= 0.03 && apart < 30) out.push('colors.accent and colors.red are too alike: pick two colors further apart.');
  for (const theme of ['dark', 'light'] as const) {
    const t = themeColors(theme, values);
    for (const [fg, bgs, min] of PAIRS) for (const bg of bgs) {
      const ratio = contrast(over(t[fg], t.surface), over(t[bg], t.surface));
      if (ratio >= min) continue;
      // name the base to change: the one the text comes from, or else the one under it (white and black come from none)
      const from = [fg, bg].map((k) => (TOKENS[k][theme === 'dark' ? 0 : 1] as Paint).base).find((b) => b === 'accent' || b === 'red') ?? 'neutral';
      out.push(`colors.${from} leaves --${fg} on --${bg} at ${ratio.toFixed(2)}:1 in the ${theme} theme, under ${min}:1, so it would be hard to read: pick a different colors.${from}.`);
    }
  }
  return out;
}

/**
 * The color tokens as CSS, one block per theme, for the build to put ahead of src/styles.css (see vite.config.ts), with
 * the dropdown arrow drawn in ink-3 and the deal status pick's in ink (an image cannot read a variable, so the color is
 * written into it here).
 * The stylesheet's own theme blocks mix the soft tints from these, and its High Contrast block still wins over them.
 * Stops with every problem named when the base colors are out of range or would leave text hard to read.
 */
export function colorCss(values: Control = control): string {
  const problems = paletteProblems(values);
  if (problems.length) throw new Error(`The control file's colors need changing:\n${problems.join('\n')}`);
  const arrow = (hex: string) => `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23${hex.slice(1)}' stroke-width='2.2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`;
  const block = (theme: Theme) => {
    const t = themeColors(theme, values);
    const colors = COLOR_NAMES.map((name) => `--${name}:${t[name]}`).join(';');
    return `:root[data-theme="${theme}"]{${colors};--select-arrow:${arrow(t['ink-3'])}}`;
  };
  return `/* from src/control.ts (colors), worked out in src/palette.ts */\n${block('dark')}\n${block('light')}\n`;
}
