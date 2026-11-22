/**
 * Finding a deal's folders on a PC where they are not at the path the deal records. Pure path work, no files:
 * the backend checks what these suggest against the documents it has recorded.
 *
 * Paths come from Windows PCs (`X:\Deals\2026\...`, `\\server\deals\...`) and, in tests, from POSIX ones. A path is a root
 * (a drive, a network share, or `/`) and the folder names under it. Windows roots and names are compared without regard
 * to case, as Windows does.
 */

export interface DealFolder { dealId: string; folder: string }
/** one place a person can point at: every missing folder under `top` is found from it */
export interface Top { top: string; folders: DealFolder[] }
/** the start of a path on the PC that recorded it, and what it is on this PC */
export interface Rule { from: string; to: string }

interface Parsed { root: string; parts: string[]; sep: '\\' | '/'; win: boolean }

export function parse(p: string): Parsed {
  const sep = p.includes('\\') ? '\\' : '/';
  const unc = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)(.*)$/.exec(p);
  if (unc) return { root: `${sep}${sep}${unc[1]}${sep}${unc[2]}`, parts: names(unc[3]), sep, win: true };
  const drive = /^([A-Za-z]:)(.*)$/.exec(p);
  if (drive) return { root: drive[1].toUpperCase(), parts: names(drive[2]), sep: '\\', win: true };
  if (p.startsWith('/')) return { root: '/', parts: names(p), sep: '/', win: false };
  return { root: '', parts: names(p), sep, win: false };
}
const names = (rest: string) => rest.split(/[\\/]+/).filter(Boolean);

export function join(root: string, parts: string[], sep: '\\' | '/'): string {
  if (root === '/') return '/' + parts.join('/');
  if (/^[A-Za-z]:$/.test(root)) return root + '\\' + parts.join('\\');
  if (!root) return parts.join(sep);
  return parts.length ? root + sep + parts.join(sep) : root;
}

const same = (a: Parsed, x: string, y: string) => (a.win ? x.toLowerCase() === y.toLowerCase() : x === y);
const sameRoot = (a: Parsed, b: Parsed) => a.win === b.win && same(a, a.root.replace(/\//g, '\\'), b.root.replace(/\//g, '\\'));
/** a path in one spelling, so two spellings of one place compare equal */
export const key = (p: string) => { const a = parse(p); const k = join(a.root.replace(/\//g, '\\'), a.parts, '\\'); return a.win ? k.toLowerCase() : k; };

/** whether `p` is `top` or inside it */
export function under(p: string, top: string): boolean {
  const a = parse(p), t = parse(top);
  return sameRoot(a, t) && t.parts.length <= a.parts.length && t.parts.every((n, i) => same(a, n, a.parts[i]));
}

/** `p` with its start `top` replaced by `to`; null when `p` is not under `top` */
export function rewrite(p: string, top: string, to: string): string | null {
  if (!under(p, top)) return null;
  const a = parse(p), t = parse(top), d = parse(to);
  return join(d.root, [...d.parts, ...a.parts.slice(t.parts.length)], d.sep);
}

/** every folder `p` is inside, nearest first, down to its root */
export function ancestors(p: string): string[] {
  const a = parse(p); const out: string[] = [];
  for (let n = a.parts.length - 1; n >= 0; n--) out.push(join(a.root, a.parts.slice(0, n), a.sep));
  return out;
}

/**
 * The rule one located folder teaches: the names the two paths end with in common are the same folders, so what comes
 * before them is the same place on the two PCs. `X:\Deals\2026\Proseware\Legal` found at `\\server\deals\2026\Proseware\Legal`
 * gives `X:\` → `\\server\deals`. Null when they end differently, or when nothing at all differs.
 */
export function ruleFrom(from: string, to: string): Rule | null {
  const a = parse(from), b = parse(to);
  let n = 0; while (n < a.parts.length && n < b.parts.length && same(a, a.parts[a.parts.length - 1 - n], b.parts[b.parts.length - 1 - n])) n++;
  if (n === 0) return null;
  const r = { from: join(a.root, a.parts.slice(0, a.parts.length - n), a.sep), to: join(b.root, b.parts.slice(0, b.parts.length - n), b.sep) };
  return key(r.from) === key(r.to) ? null : r;
}

/** where a folder may be on this PC by the rules known here, the most particular rule first; the folder's own path is not among them */
export function candidates(folder: string, rules: Rule[]): string[] {
  const fit = rules.filter((r) => under(folder, r.from)).sort((x, y) => parse(y.from).parts.length - parse(x.from).parts.length);
  const out: string[] = []; const seen = new Set([key(folder)]);
  for (const r of fit) { const c = rewrite(folder, r.from, r.to); if (c && !seen.has(key(c))) { seen.add(key(c)); out.push(c); } }
  return out;
}

/**
 * A folder under another person's Windows profile (`C:\Users\adoe\...`) is looked for under this person's (`home`),
 * as when the deal's folders are a team library OneDrive keeps under each person's profile. Null when either is not a profile path.
 */
export function profileCandidate(folder: string, home: string): string | null {
  const m = /^([A-Za-z]:[\\/]Users[\\/])[^\\/]+(.*)$/i.exec(folder); const h = /^[A-Za-z]:[\\/]Users[\\/][^\\/]+$/i.exec(home.replace(/[\\/]+$/, ''));
  if (!m || !h) return null;
  const c = home.replace(/[\\/]+$/, '') + m[2];
  return key(c) === key(folder) ? null : c;
}

/**
 * The places to point at for the folders still missing: the folder several deals' folders share (`X:\Deals\2026`), so that
 * one choice finds them all, rather than each folder. A folder no other deal's folder shares a parent with goes under its
 * own deal's top folder (its folders' common start), or is its own top when that start is a bare drive or share. A top
 * inside another is folded into it. Most folders first.
 */
export function topsOf(missing: DealFolder[]): Top[] {
  const pick = (f: DealFolder): string => {
    for (const a of ancestors(f.folder)) {
      if (!parse(a).parts.length) break;                                    // a bare drive or share is not offered: too wide to mean one place
      const deals = new Set(missing.filter((m) => under(m.folder, a)).map((m) => m.dealId));
      if (deals.size >= 2) return a;
    }
    const own = missing.filter((m) => m.dealId === f.dealId && sameRoot(parse(m.folder), parse(f.folder))).map((m) => m.folder);
    const start = common(own);
    return start && parse(start).parts.length ? start : f.folder;
  };
  const chosen = missing.map((f) => ({ f, top: pick(f) }));
  // a top inside another top is the same place deeper down: the outer one finds it too
  const outer = (t: string) => chosen.map((c) => c.top).filter((o) => under(t, o)).sort((x, y) => parse(x).parts.length - parse(y).parts.length)[0] ?? t;
  const by = new Map<string, Top>();
  for (const { f, top } of chosen) { const t = outer(top); const k = key(t); const g = by.get(k) ?? { top: t, folders: [] }; g.folders.push(f); by.set(k, g); }
  return [...by.values()].sort((a, b) => b.folders.length - a.folders.length || (key(a.top) < key(b.top) ? -1 : 1));
}

/** the longest start the paths share, as a path; null when they share no root */
function common(paths: string[]): string | null {
  if (!paths.length) return null;
  const p = paths.map(parse); const first = p[0];
  if (!p.every((x) => sameRoot(x, first))) return null;
  let n = 0; while (p.every((x) => n < x.parts.length && same(first, x.parts[n], first.parts[n]))) n++;
  return join(first.root, first.parts.slice(0, n), first.sep);
}

/**
 * Where `top` may be when a person picked a folder above it, as people often stop one level up in a folder picker: the
 * picked folder with the top folder's last name, then its last two names (X:\Deals\2026 picked as \\server\deals gives
 * \\server\deals\2026, then \\server\deals\Deals\2026).
 */
export function deeper(top: string, picked: string): string[] {
  const t = parse(top).parts; const p = parse(picked);
  return [1, 2].filter((n) => t.length >= n).map((n) => join(p.root, [...p.parts, ...t.slice(-n)], p.sep));
}
