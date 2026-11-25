/**
 * The firm's checklist and each deal's items (linking design, sections 4 and 5).
 *
 * The firm keeps its lists in four layers: the general list, and a list for each structure, sector and technology. A deal
 * is checked against the general list plus the lists named by its Structure (`product`), Sector and Technology. Each
 * deal holds its own items, which are only ever added, never removed or reworded; a person can turn one off.
 *
 * An item's identity is its deal plus its wording, normalized (`key`), so the same wording added twice, on one PC or
 * two, is one item.
 */
import { z } from 'zod';
import { DealId } from './model';

/** The layers in the order the checks and the Checklist page take them. `broad` is the general list, `product` the structure. */
export const LAYERS = ['broad', 'product', 'sector', 'technology'] as const;
export type Layer = typeof LAYERS[number];
/** what each layer is called on screen, one list and several */
export const LAYER_NAMES: Record<Layer, { one: string; many: string }> = {
  broad: { one: 'General', many: 'General' }, product: { one: 'Structure', many: 'Structures' },
  sector: { one: 'Sector', many: 'Sectors' }, technology: { one: 'Technology', many: 'Technologies' },
};
/** a structure, sector or technology is named in about 24 characters or fewer (decisions page) */
export const LIST_NAME_MAX = 24;

/**
 * A wording folded for comparing only, never for storing or showing (the app keeps and shows every wording exactly as it
 * was handed over): Unicode NFC; zero-width characters and soft hyphens removed; curly and low quotes, primes
 * and modifier apostrophes made straight; the dashes U+2010–U+2015 and the minus sign made "-"; non-breaking spaces made
 * spaces; the common ligatures unfolded; white space trimmed, and each run of it made one space.
 */
export function norm(text: string): string {
  return text.normalize('NFC')
    .replace(/[​-‍⁠﻿­]/g, '')
    .replace(/[‘’‚‛′ʼʹ]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[   ]/g, ' ')
    .replace(/[ﬀ-ﬆ]/g, (c) => c.normalize('NFKC'))
    .replace(/\s+/g, ' ').trim();
}

/**
 * What makes two wordings one item: the normalized wording with its case folded (upper then lower case, so "Straße" and
 * "STRASSE" are one key) and without a trailing period. Case and a final period never make two items.
 */
export function key(text: string): string {
  return norm(text).toUpperCase().toLowerCase().replace(/\.$/, '').trim();
}

/** an item's id: `i_` and the first 24 hex digits of the SHA-256 of the deal's id, a NUL, and the wording's key */
export function itemId(dealId: string, text: string): string {
  return 'i_' + sha256Hex(`${dealId}\0${key(text)}`).slice(0, 24);
}

/**
 * One item of one list of the firm's, as brought in: its wording and, if the file had them, its section and subsection
 * headings. `was` is the file's own wording when a person took a suggested rewording, so that the same file brought in
 * again offers that rewording already checked rather than adding the old wording as a second item.
 */
export const ListItem = z.object({ text: z.string().min(1), section: z.string().optional(), subsection: z.string().optional(), was: z.string().optional() }).loose();
export type ListItem = z.infer<typeof ListItem>;

/** One list: the general list (no name), or the list for one structure, sector or technology. */
export const FirmLayerList = z.object({
  layer: z.enum(LAYERS),
  /** the structure, sector or technology the list is for, as it reads in pick lists; '' for the general list */
  name: z.string(),
  items: z.array(ListItem),
  /** who brought this list in, and when */
  by: z.string(),
  at: z.string(),
  /** the file it came from, and the file's own date (YYYY-MM-DD, '' when unknown): an older file asks before it replaces a newer one */
  file: z.string().default(''),
  fileDate: z.string().default(''),
}).loose();
export type FirmLayerList = z.infer<typeof FirmLayerList>;

/**
 * One list of the firm's as a shared record (kind `firmList`; linking design, section 4). Each list is a record of
 * its own, so two different lists brought in on two PCs at once both stand, and only the same list brought in on two PCs
 * at once can be in two versions. Its id is fixed by what the list is (`listId`), so the same list on two PCs is one record.
 */
export const ListId = z.string().regex(/^l_[0-9a-f]{24}$/);
export const ListRecord = FirmLayerList.extend({
  id: ListId,
  rev: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ListRecord = z.infer<typeof ListRecord>;

/** a list's id: `l_` and the first 24 hex digits of the SHA-256 of its layer, a NUL, and its name's key ('' for the general list) */
export function listId(layer: Layer, name: string): string {
  return 'l_' + sha256Hex(`${layer}\0${layer === 'broad' ? '' : key(name)}`).slice(0, 24);
}

/** The firm's lists, read together: what the functions below take. */
export interface FirmList { lists: FirmLayerList[] }

/** The firm's lists from their records, in an order every PC agrees on: by layer, then by name's key (code-unit order). */
export function firmOf(records: Record<string, ListRecord> | ListRecord[]): FirmList {
  const all = Array.isArray(records) ? records : Object.values(records);
  const k = (l: FirmLayerList) => key(l.name);
  return { lists: [...all].sort((a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer) || (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0)) };
}

/** Where an item came from: a layer of the firm's list (and which list in it). 'deal' stays in the schema but nothing
 * writes it: there is no Add an item. */
export const ItemFrom = z.object({ layer: z.enum([...LAYERS, 'deal']), value: z.string().default(''), /** the rev of that list that added the item (linking design, section 5): a PC whose copy of the list is older offers no "Add them" */ rev: z.number().int().nonnegative().optional() }).loose();
export type ItemFrom = z.infer<typeof ItemFrom>;

/** One item on one deal (kind `item`). Its wording never changes; turning it off and on is the only change a person makes. */
export const ItemId = z.string().regex(/^i_[0-9a-f]{24}$/);
export const Item = z.object({
  id: ItemId,
  dealId: DealId,
  rev: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** the wording, normalized (norm) */
  text: z.string().min(1),
  /** the version of norm() and key() the id was made with */
  normV: z.literal(1).default(1),
  /** where it comes from (bookkeeping): every layer and list that holds it */
  from: z.array(ItemFrom).default([]),
  /** the section heading it was listed under, when its list had one */
  section: z.string().optional(),
  /** the subsection heading under its section, when its list had one */
  subsection: z.string().optional(),
  /** true while a person has turned it off for this deal */
  off: z.boolean().default(false),
  /** true while it is off because a swap turned it off, not a person: only these come back on when the list is picked again */
  offBySwap: z.boolean().optional(),
}).loose();
export type Item = z.infer<typeof Item>;

/** A deal's layers: which list of each layer applies to it. The general list always does. */
export function dealLayers(d: { product?: string; sector?: string; technology?: string }): { layer: Layer; value: string }[] {
  return [{ layer: 'broad', value: '' }, { layer: 'product', value: d.product ?? '' }, { layer: 'sector', value: d.sector ?? '' }, { layer: 'technology', value: d.technology ?? '' }]
    .filter((l) => l.layer === 'broad' || key(l.value) !== '') as { layer: Layer; value: string }[];
}

/** The firm's list for a layer and name, if it has one. Names are matched as wordings are: case and spacing do not matter. */
export function findList(firm: FirmList | null | undefined, layer: Layer, name: string): FirmLayerList | undefined {
  return firm?.lists.find((l) => l.layer === layer && (layer === 'broad' || key(l.name) === key(name)));
}

/**
 * What the firm's list says a deal should hold: each item of each of its layers, in layer order, once. An item in two
 * layers names both in `from`.
 */
export function itemsFor(firm: FirmList | null | undefined, d: { product?: string; sector?: string; technology?: string }): { text: string; section?: string; subsection?: string; from: ItemFrom[] }[] {
  const out = new Map<string, { text: string; section?: string; subsection?: string; from: ItemFrom[] }>();
  for (const { layer, value } of dealLayers(d)) {
    const list = findList(firm, layer, value); if (!list) continue;
    for (const it of list.items) {
      const text = norm(it.text); const k = key(text); if (!k) continue;
      const had = out.get(k); const rev = (list as { rev?: unknown }).rev; const from = { layer, value: list.name, ...(typeof rev === 'number' ? { rev } : {}) };
      if (had) { if (!had.from.some((f) => f.layer === layer && f.value === list.name)) had.from.push(from); }
      else out.set(k, { text, ...(it.section ? { section: it.section } : {}), ...(it.subsection ? { subsection: it.subsection } : {}), from: [from] });
    }
  }
  return [...out.values()];
}

/**
 * The items a change of one layer leaves behind: those on the deal, still on, that the old list holds and no list the
 * deal will have after the change does (the general list, its other layers, the new list). An item a person added to the
 * deal is never among them. Offered to be turned off with the change (a wrong technology picked by mistake).
 */
export function leftBehind(firm: FirmList | null | undefined, items: Item[], d: { product?: string; sector?: string; technology?: string }, layer: Exclude<Layer, 'broad'>, next: string): Item[] {
  const old = findList(firm, layer, d[layer] ?? ''); if (!old || key(d[layer] ?? '') === key(next)) return [];
  const was = new Set(old.items.map((it) => key(it.text)));
  const stays = new Set(itemsFor(firm, { ...d, [layer]: next }).map((w) => key(w.text)));
  return items.filter((i) => !i.off && was.has(key(i.text)) && !stays.has(key(i.text)) && !i.from.some((f) => f.layer === 'deal'));
}

/**
 * The new list's items that are on the deal but turned off by a swap, as a list picked again after being changed away
 * from leaves them. An item a person turned off stays off (linking design, section 5).
 */
export function turnedOffIn(firm: FirmList | null | undefined, items: Item[], d: { product?: string; sector?: string; technology?: string }, layer: Exclude<Layer, 'broad'>, next: string): Item[] {
  const list = findList(firm, layer, next); if (!list || key(d[layer] ?? '') === key(next)) return [];
  const has = new Set(list.items.map((it) => key(it.text)));
  // an item a list the deal already has holds was turned off by a person, not by a swap: it stays off
  const held = new Set(itemsFor(firm, d).map((w) => key(w.text)));
  return items.filter((i) => i.off && i.offBySwap && has.has(key(i.text)) && !held.has(key(i.text)));
}

/** The deal's items in the order the design gives (section 5): by layer, then in the order of the firm's current list, then the rest by when they were added. */
export function orderItems(items: Item[], firm: FirmList | null | undefined): Item[] {
  const place = new Map<string, number>(); let n = 0;
  for (const layer of LAYERS) for (const l of firm?.lists.filter((x) => x.layer === layer) ?? []) for (const it of l.items) { const k = key(it.text); if (!place.has(k)) place.set(k, n++); }
  const rank = (it: Item) => { const f = it.from.find((x) => x.layer !== 'deal'); return f ? LAYERS.indexOf(f.layer as Layer) : LAYERS.length; };
  return [...items].sort((a, b) => {
    const pa = place.get(key(a.text)), pb = place.get(key(b.text));
    if (pa !== undefined || pb !== undefined) { if (pa === undefined) return 1; if (pb === undefined) return -1; if (pa !== pb) return pa - pb; }
    return rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}

/** SHA-256 of a string's UTF-8 bytes, in hex. Small and synchronous, so ids can be made in the browser and on Node alike. */
export function sha256Hex(s: string): string {
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const bytes = new TextEncoder().encode(s); const len = bytes.length;
  const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64); padded.set(bytes); padded[len] = 0x80;
  const bits = len * 8; const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bits / 0x100000000)); dv.setUint32(padded.length - 4, bits >>> 0);
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const W = new Uint32Array(64); const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < padded.length; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) { const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3); const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10); W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0; }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0; H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return H.map((x) => x.toString(16).padStart(8, '0')).join('');
}
