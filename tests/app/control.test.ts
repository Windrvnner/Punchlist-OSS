import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { control, checkControl, assertControl, notes, shownName, SERVICE, AI_LABEL, type Control } from '../../src/control';
import { COLOR_NAMES } from '../../src/palette';

/** every color CSS knows by name, and the system colors, which only Windows High Contrast may use */
const CSS_COLOR_NAMES = `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse
chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen
darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey
dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory
khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon
lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid
mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace
olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple
red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal
thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen
Canvas CanvasText GrayText Highlight HighlightText ButtonFace ButtonText ButtonBorder LinkText VisitedText ActiveText Field FieldText Mark MarkText AccentColor AccentColorText`.split(/\s+/).join('|');

/** the shipped values with some changed, as an edit to the control file would change them */
const edited = (change: (c: Record<string, Record<string, unknown>>) => void): Control => {
  const c = structuredClone(control) as unknown as Record<string, Record<string, unknown>>; change(c); return c as unknown as Control;
};

describe('the control file', () => {
  it('ships with every value in range, so the app starts', () => {
    expect(checkControl()).toEqual([]);
    expect(() => assertControl()).not.toThrow();
  });

  it('has a one-line note on every value', () => {
    for (const [g, values] of Object.entries(control)) for (const k of Object.keys(values)) {
      const note = notes[`${g}.${k}`];
      expect(note, `${g}.${k}`).toBeTruthy(); expect(note).not.toContain('\n');
    }
  });

  it('names a value out of range, and the range it may take', () => {
    expect(checkControl(edited((c) => { c.limits.docsPerCall = 80; }))).toEqual(['limits.docsPerCall must be a whole number from 1 to 20.']);
    expect(checkControl(edited((c) => { c.timings.modelWait = 5; }))).toEqual(['timings.modelWait must be a time in milliseconds from 10 s to 30 min.']);
    expect(checkControl(edited((c) => { c.blackline.pipeline = 'C'; }))).toEqual(["blackline.pipeline must be one of 'A', 'B'."]);
    expect(checkControl(edited((c) => { c.firm.name = ''; }))[0]).toMatch(/^firm\.name must be text of 1 to 80/);
    expect(checkControl(edited((c) => { c.firm.name = 'Contoso '; }))).toEqual(['firm.name must not start or end with a space.']);
  });

  it('keeps the file-store default and the inclusive whole-number range', () => {
    expect(control.limits.storedFiles).toBe(500);
    for (const value of [10, 5000]) {
      expect(checkControl(edited((c) => { c.limits.storedFiles = value; }))).toEqual([]);
    }
    for (const value of [9, 10.5, 5001]) {
      expect(checkControl(edited((c) => { c.limits.storedFiles = value; })))
        .toEqual(['limits.storedFiles must be a whole number from 10 to 5,000.']);
    }
  });

  it('reports every problem at once, and a value missing or of the wrong kind', () => {
    const problems = checkControl(edited((c) => { c.limits.chatTurns = 0; delete c.limits.searchCalls; c.lists.searchFiller = 'agreement'; }));
    expect(problems).toEqual(['limits.chatTurns must be a whole number from 1 to 100.', 'limits.searchCalls is missing.', 'lists.searchFiller must list 0 to 2000 entries.']);
  });

  it.each(['gateway', 'azure', 'bedrock', 'vertex'] as const)('validates the %s route at startup', (provider) => {
    const apiKeyOnly = edited((c) => {
      c.models.service = provider;
      c.signIn.sso = false;
      Object.assign(c[provider], {
        address: {
          gateway: 'https://gateway.example.test/v1',
          azure: 'https://azure.example.test/openai/v1',
          bedrock: 'https://bedrock.example.test',
          vertex: 'https://vertex.example.test/v1/projects/project/locations/global/publishers/anthropic/models',
        }[provider],
        fast: 'fast-model', standard: 'standard-model', thorough: 'thorough-model',
      });
      c.bedrock.region = 'us-east-1';
    });
    expect(checkControl(apiKeyOnly)).toEqual([]);
    const incomplete = { ...apiKeyOnly, signIn: { sso: true, apiKey: false } };
    expect(checkControl(incomplete)[0]).toContain(`models.service '${provider}' needs ${provider}.`);
    const configured = {
      ...incomplete,
      gateway: {
        ...incomplete.gateway, authorize: 'https://sso.example.test/authorize', token: 'https://sso.example.test/token',
        clientId: 'public-client', scope: 'models',
      },
      azure: {
        ...incomplete.azure, tenant: '00000000-0000-0000-0000-000000000001',
        clientId: '00000000-0000-0000-0000-000000000002',
      },
      bedrock: {
        ...incomplete.bedrock, ssoRegion: 'us-east-1', startUrl: 'https://example.awsapps.com/start',
        account: '000000000000', role: 'ModelUser',
      },
      vertex: { ...incomplete.vertex, clientId: 'desktop-client' },
    };
    expect(checkControl(configured)).toEqual([]);
    expect(checkControl({
      ...configured, [provider]: { ...configured[provider], address: 'http://models.example.test' },
    })[0]).toMatch(/^\w+\.address must be (?:an )?https/i);
  });

  it('takes a North address and SSO site as https and a host only, or empty while not set', () => {
    for (const ok of ['', 'https://north.example.com', 'https://sso.example.com:8443']) expect(checkControl(edited((c) => { c.north.address = ok; c.north.ssoSite = ok; }))).toEqual([]);
    for (const bad of ['http://north.example.com', 'https://north.example.com/', 'https://north.example.com/login', 'north.example.com']) {
      expect(checkControl(edited((c) => { c.north.ssoSite = bad; })), bad).toHaveLength(1);
    }
  });

  it('checks lists entry by entry, and takes each base color as #rrggbb', () => {
    expect(checkControl(edited((c) => { c.lists.searchFiller = ['the', 'The']; }))).toEqual(["lists.searchFiller lists 'The' twice."]);
    expect(checkControl(edited((c) => { c.lists.indexFiller = ['the', ' ']; }))[0]).toMatch(/empty entry/);
    expect(checkControl(edited((c) => { c.colors.accent = '#d9c5a'; }))).toEqual(['colors.accent must be a hex color like #2e4a63.']);
    for (const bad of ['', 'red', '#fff', 'rgb(1,2,3)', '#000000;}body{display:none', 7]) expect(checkControl(edited((c) => { c.colors.red = bad; })), String(bad)).toHaveLength(1);
  });

  it("takes the firm's workstreams as short one-line names, each once, never the list's own \"No workstream\"", () => {
    expect(control.firm.workstreams).toContain('Structure'); expect(control.firm.workstreams).toHaveLength(14);
    expect(checkControl(edited((c) => { c.firm.workstreams = ['Legal', 'legal']; }))).toEqual(["firm.workstreams lists 'legal' twice."]);
    expect(checkControl(edited((c) => { c.firm.workstreams = []; }))).toEqual(['firm.workstreams must list 1 to 40 entries.']);
    expect(checkControl(edited((c) => { c.firm.workstreams = ['Legal', 'No Workstream']; }))[0]).toMatch(/must not list 'No Workstream'/);
    expect(checkControl(edited((c) => { c.firm.workstreams = ['x'.repeat(41)]; }))[0]).toMatch(/longer than 40 characters/);
    expect(checkControl(edited((c) => { c.firm.workstreams = ['Legal\nTax']; }))[0]).toMatch(/line break/);
    expect(checkControl(edited((c) => { c.firm.workstreams = ['Légal', 'Legal']; }))).toEqual(["firm.workstreams lists 'Légal' and 'Legal', which read as one."]);
    expect(checkControl(edited((c) => { c.firm.workstreams = ['ﬁnance', 'Finance']; }))[0]).toMatch(/read as one/);
    expect(checkControl(edited((c) => { c.firm.workstreams = ['Legal\u200b']; }))[0]).toMatch(/unseen/);
    expect(checkControl(edited((c) => { c.firm.workstreams = ['Legal\u2028Tax']; }))[0]).toMatch(/line break/);
    expect(checkControl(edited((c) => { c.firm.workstreams = ['Legal', 5 as never]; }))[0]).toMatch(/not text/);
    expect(checkControl(edited((c) => { c.firm.workstreams = ['Corporate structure', 'x'.repeat(40)]; }))).toEqual([]);
  });

  it('holds every color the stylesheets use: no color is written in them, and each token they read is defined', () => {
    const sheets = ['src/styles.css', 'src/ui/ui.css'].map((f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
    // the only literal left is black in a mask (--mask, and mask-image fades), which uses only its opacity and is never painted
    const unmasked = sheets.replace(/--mask:#000;/g, '').replace(/mask-image:linear-gradient\(to right,#000 /g, '');
    // a color written out: hex (in CSS or in an SVG drawn inline, %23 being #), or a color function
    const literals = [...unmasked.matchAll(/(?:#|%23)[0-9a-f]{3,8}(?![-\w])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi)].map((m) => unmasked.slice(m.index, m.index + 24));
    expect(literals).toEqual([]);
    // nor a color by its name, in any declaration (system colors only in the Windows High Contrast blocks)
    const outsideHighContrast = unmasked.replace(/@media \(forced-colors:active\)\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
    const values = [...outsideHighContrast.matchAll(/(?:^|[;{\s])(-{0,2}[a-z][a-z0-9-]*):([^;{}]*)/gim)].map((m) => `${m[1]}:${m[2]}`).filter((d) => !/^[a-z-]+:(?:hover|focus|active|not|is|where|has|before|after|first|last|nth|disabled|checked|focus-visible|focus-within|placeholder|empty|root)\b/.test(d));
    const named = values.filter((d) => new RegExp(`:.*?(?<![\\w-])(?:${CSS_COLOR_NAMES})(?![\\w-])`, 'i').test(d.replace(/url\([^)]*\)|"[^"]*"|'[^']*'/g, '')));
    expect(named).toEqual([]);
    const PAINT = /(?:color|background|border|shadow|fill|stroke|outline|caret|decoration|filter|mask|column-rule|text-emphasis)[a-z-]*:[^;}]*/gi;
    const declared = [...sheets.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]);
    const defined = new Set(declared.concat(COLOR_NAMES.map((n) => `--${n}`), '--select-arrow'));
    // the tokens read where a color is painted (other tokens, such as widths the code sets, are not colors)
    const used = new Set([...sheets.matchAll(PAINT)].flatMap((m) => [...m[0].matchAll(/var\((--[a-z0-9-]+)/gi)].map((v) => v[1])));
    expect([...used].filter((u) => !defined.has(u))).toEqual([]);
  });

  it('takes a folder name Windows accepts for the shared folder', () => {
    for (const bad of ['Team/Punchlist', 'a:b', '..']) expect(checkControl(edited((c) => { c.desktop.sharedFolder = bad; })), bad).toHaveLength(1);
  });

  it('takes the team folder\'s share link as an https:// address, or empty', () => {
    for (const good of ['', 'https://example-my.sharepoint.com/:f:/g/personal/a_b/EaBc?e=x1']) expect(checkControl(edited((c) => { c.desktop.teamFolderLink = good; })), good).toEqual([]);
    for (const bad of ['http://example.com/f', 'example.com/f']) expect(checkControl(edited((c) => { c.desktop.teamFolderLink = bad; })), bad).toHaveLength(1);
  });

  /** North's model names, which have no default */
  const named = (c: Record<string, Record<string, unknown>>) => {
    Object.assign(c.models, { northFast: 'f', northStandard: 's', northThorough: 't' });
  };
  it('checks values that depend on each other', () => {
    expect(checkControl(edited((c) => { c.limits.shortlist = 8; c.limits.docsPerCall = 9; }))).toEqual(['limits.shortlist must be at least limits.docsPerCall.']);
    expect(checkControl(edited((c) => { c.timings.roundRenew = c.timings.roundLapse; }))[0]).toMatch(/^timings\.roundRenew must be shorter/);
    expect(checkControl(edited((c) => { c.models.service = 'north'; }))).toEqual([
      "models.service 'north' needs north.address set.",
      "models.service 'north' needs models.northFast, models.northStandard and models.northThorough set.",
      'signIn.sso on North needs north.ssoSite set (or turn signIn.sso off).',
    ]);
    expect(
      checkControl(
        edited((c) => {
          c.models.service = 'north';
          named(c);
          c.north.address = 'https://north.example.com';
          c.signIn.sso = false;
        }),
      ),
    ).toEqual([]);
    expect(
      checkControl(
        edited((c) => {
          c.models.service = 'north';
          named(c);
          c.north.address = 'https://north.example.com';
          c.north.ssoSite = 'https://sso.example.com';
        }),
      ),
    ).toEqual([]);
    expect(checkControl(edited((c) => { c.models.service = 'openai'; c.openai.address = 'https://models.example.com/v1'; c.models.openaiFast = 'small'; }))).toEqual(["models.service 'openai' needs openai.address, models.openaiFast, models.openaiStandard and models.openaiThorough set."]);
    expect(checkControl(edited((c) => { c.models.service = 'openai'; c.openai.address = 'https://models.example.com/v1'; c.models.openaiFast = 'small'; c.models.openaiStandard = 'mid'; c.models.openaiThorough = 'large'; }))).toEqual([]);
    const openAiWithoutKey = edited((c) => {
      c.models.service = 'openai';
      c.openai.address = 'https://models.example.com/v1';
      c.models.openaiFast = 'small';
      c.models.openaiStandard = 'mid';
      c.models.openaiThorough = 'large';
      c.signIn.apiKey = false;
    });
    const claudeWithoutKey = edited((c) => { c.models.service = 'claude'; c.signIn.apiKey = false; });
    expect(checkControl(openAiWithoutKey)).toEqual([
      "signIn.apiKey cannot be off with models.service 'openai': that service requires an API key.",
    ]);
    expect(checkControl(claudeWithoutKey)).toEqual([
      "signIn.apiKey cannot be off with models.service 'claude': that service requires an API key.",
    ]);
    expect(
      checkControl(
        edited((c) => {
          c.models.service = 'north';
          named(c);
          c.north.address = 'https://north.example.com';
          c.north.ssoSite = 'https://sso.example.com';
          c.signIn.apiKey = false;
        }),
      ),
    ).toEqual([]);
    expect(checkControl(edited((c) => { c.signIn.sso = false; c.signIn.apiKey = false; }))[0]).toMatch(/^signIn\.sso and signIn\.apiKey cannot both be off/);
    expect(checkControl(edited((c) => { c.picker.fast = false; c.picker.standard = false; c.picker.thorough = false; }))[0]).toMatch(/^picker\.fast, picker\.standard and picker\.thorough cannot all be off/);
  });

  it('stops the app with every problem named', () => {
    const bad = edited((c) => { c.limits.docsPerCall = 0; c.firm.name = ''; });
    expect(() => assertControl(bad)).toThrow(/out of range[\s\S]*- limits\.docsPerCall[\s\S]*- firm\.name|out of range[\s\S]*- firm\.name[\s\S]*- limits\.docsPerCall/);
  });

  it('cannot be changed while the app runs', () => {
    expect(() => { (control.limits as { docsPerCall: number }).docsPerCall = 9; }).toThrow();
    expect(() => { (control.lists.searchFiller as string[]).push('x'); }).toThrow();
    expect(control.limits.docsPerCall).toBe(8);
  });
});

describe('the names shown on screen', () => {
  it('ship as "Intelligence" and "AI"', () => {
    expect([SERVICE, AI_LABEL]).toEqual(['Intelligence', 'AI']);
  });
  it('a name that cannot be shown falls back to the default, and never stops the app', () => {
    for (const bad of ['', '   ', 'x'.repeat(41), 'Line\nbreak', '<b>Bold</b>', 42, null, undefined]) expect(shownName(bad, 'Intelligence')).toBe('Intelligence');
    expect(shownName('  Lamna Brain ', 'Intelligence')).toBe('Lamna Brain');
    expect(checkControl(edited((c) => { c.names.service = ''; c.names.aiContent = 7; }))).toEqual([]);
  });
});
