import { describe, it, expect } from 'vitest';
import { control, type Control } from '../../src/control';
import { colorCss, COLOR_NAMES, contrast, oklch, paletteProblems, themeColors } from '../../src/palette';

/** the shipped control file with other base colors, as an edit to the control file would set them */
const bases = (colors: Partial<Record<'neutral' | 'accent' | 'red', string>>): Control => ({ ...control, colors: { ...control.colors, ...colors } }) as Control;
const block = (css: string, theme: 'dark' | 'light') => css.split('\n').find((l) => l.startsWith(`:root[data-theme="${theme}"]`)) ?? '';
/** a token's hue in degrees, from its CSS value (#rrggbb, or rgba() for one that lets what is behind it show) */
const hueOf = (v: string) => { const m = v.match(/^rgba\((\d+),(\d+),(\d+),/); return oklch(m ? '#' + m.slice(1, 4).map((x) => Number(x).toString(16).padStart(2, '0')).join('') : v)[2]; };
/** two hues within `by` degrees; a near-gray's hue moves more when rounded to whole sRGB steps, so it is checked more loosely */
const near = (h1: number, h2: number, by = 4) => Math.min(Math.abs(h1 - h2), 360 - Math.abs(h1 - h2)) < by;

describe('the colors worked out from the base colors', () => {
  it('ship readable in both themes, so the build goes ahead', () => {
    expect(paletteProblems()).toEqual([]);
    expect(() => colorCss()).not.toThrow();
  });

  it('write every token for both themes, and nothing else', () => {
    const css = colorCss();
    for (const theme of ['dark', 'light'] as const) {
      const t = themeColors(theme);
      for (const name of COLOR_NAMES) expect(block(css, theme), `${theme} ${name}`).toContain(`--${name}:${t[name]};`);
      for (const v of Object.values(t)) expect(v).toMatch(/^(?:#[0-9a-f]{6}|rgba\(\d{1,3},\d{1,3},\d{1,3},(?:0|1|0?\.\d+)\)|(?:-?\d+(?:px)? )+(?:#[0-9a-f]{6}|rgba\([^)]*\))(?:,(?:-?\d+(?:px)? )+(?:#[0-9a-f]{6}|rgba\([^)]*\)))*)$/);
    }
  });

  it('turn red and its light tint blue when red is set to blue, in both themes, and leave the rest as they were', () => {
    const blue = '#1f5fbf', was = { dark: themeColors('dark'), light: themeColors('light') };
    for (const theme of ['dark', 'light'] as const) {
      const now = themeColors(theme, bases({ red: blue }));
      expect(near(hueOf(now.high), oklch(blue)[2]), `${theme} --high ${now.high}`).toBe(true);
      // the light red is mixed from --high in the stylesheet (--high-soft), so it follows; it stays as light as red was
      expect(Math.abs(oklch(now.high)[0] - oklch(was[theme].high)[0])).toBeLessThan(0.01);
      for (const name of COLOR_NAMES) if (name !== 'high') expect(now[name], `${theme} ${name}`).toBe(was[theme][name]);
    }
  });

  it('take the accent and the neutral the same way: every token of the family follows its base', () => {
    const teal = '#1d7f86', warm = '#7a7466';
    for (const theme of ['dark', 'light'] as const) {
      const t = themeColors(theme, bases({ accent: teal, neutral: warm }));
      // the accent is a gray of the neutral in both themes; the document highlight and mark still take colors.accent
      for (const name of ['paper-hl', 'paper-mark'] as const) expect(near(hueOf(t[name]), oklch(teal)[2]), `${theme} ${name}`).toBe(true);
      for (const name of ['surface', 'ink', 'ink-2', 'ink-3', 'menu-solid', 'paper', 'th-bg', 'row-alt', 'accent'] as const) expect(near(hueOf(t[name]), oklch(warm)[2], 15), `${theme} ${name}`).toBe(true);
    }
  });

  it("keep the dark theme's cool slate background from before the base colors", () => {
    // main's hand-set dark grays before the base colors, to within one step of 255
    const was: Partial<Record<(typeof COLOR_NAMES)[number], string>> = { surface: '#0e1013', 'ink-3': '#93969c', 'menu-solid': '#1a1c20', 'th-bg': '#15171b', 'row-alt': '#1a1d21', menu: 'rgba(26,28,32,', capsule: 'rgba(24,26,30,', 'glass-solid': 'rgba(24,26,30,', 'light-b': 'rgba(120,150,190,' };
    const rgb = (v: string) => (v.startsWith('#') ? [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) : v.slice(5).split(',').slice(0, 3).map(Number));
    const dark = themeColors('dark');
    for (const [name, v] of Object.entries(was) as [(typeof COLOR_NAMES)[number], string][]) rgb(dark[name]).forEach((c, i) => { expect(Math.abs(c - rgb(v)[i]), name).toBeLessThanOrEqual(1); });
  });

  it('keep each token as light as its role needs whatever base is set, so text stays readable', () => {
    for (const [accent, red] of [['#000080', '#8b0000'], ['#ffff00', '#ff0000'], ['#00ffff', '#ff4500'], ['#2e4a63', '#c0392b']]) {
      expect(paletteProblems(bases({ accent, red })), `${accent} ${red}`).toEqual([]);
      for (const theme of ['dark', 'light'] as const) {
        const t = themeColors(theme, bases({ accent, red }));
        expect(contrast(t['accent-ink'], t.accent)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.high, t.surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('stop the build, naming the base to change, when text would be hard to read or two meanings would look alike', () => {
    expect(paletteProblems(bases({ red: '#00aa00' }))).toEqual(['colors.red leaves --high on --surface at 4.34:1 in the light theme, under 4.5:1, so it would be hard to read: pick a different colors.red.']);
    expect(() => colorCss(bases({ red: '#00aa00' }))).toThrow(/colors\.red leaves --high on --surface/);
    expect(paletteProblems(bases({ red: '#808080' }))).toEqual(['colors.red is too close to a gray: pick a stronger color.']);
    expect(paletteProblems(bases({ red: '#c49a3c' }))).toEqual(['colors.accent and colors.red are too alike: pick two colors further apart.']);
    expect(paletteProblems(bases({ neutral: '#336699' }))).toEqual(['colors.neutral is too colorful for backgrounds and text: pick a gray, or a gray with a slight tint.']);
    expect(paletteProblems(bases({ accent: '#000;}body{display:none' }))).toEqual(['colors.accent must be a hex color like #2e4a63.']);
    expect(() => colorCss(bases({ accent: '#000;}body{display:none' }))).toThrow(/colors\.accent must be a hex color/);
  });

  it("draws the dropdown arrow in each theme's --ink-3, so it follows a change to the neutral", () => {
    const changed = bases({ neutral: '#707883' }), css = colorCss(changed);
    for (const theme of ['dark', 'light'] as const) {
      expect(block(css, theme)).toMatch(new RegExp(`--select-arrow:url\\("data:image/svg\\+xml,[^"]*stroke='%23${themeColors(theme, changed)['ink-3'].slice(1)}'[^"]*"\\)\\}$`));
    }
  });

  it('give the deal memo the light theme colors, so it changes with the base colors too', () => {
    expect(themeColors('light').accent).toMatch(/^#[0-9a-f]{6}$/);
    expect(themeColors('light', bases({ neutral: '#7a7466' })).accent).not.toBe(themeColors('light').accent);
    expect(themeColors('light', bases({ accent: '#1d7f86' }))['paper-hl']).not.toBe(themeColors('light')['paper-hl']);
  });
});
