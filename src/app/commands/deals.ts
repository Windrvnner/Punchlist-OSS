import { z } from 'zod';
import { define } from '../command';
import { Deal, DealGroup, DealId, Folder, Tombstone, memberId } from '../../domain/model';
import { firstMember } from './members';
import { ok, fail, notFound, rejected } from '../../domain/result';
import { ItemId, key, leftBehind, turnedOffIn } from '../../domain/checklist';
import { addItems, missingItems, setOff, usableFirm } from './checklist';

/** the longest a folder's label can be, on a new deal, on folders added later and when it is changed */
export const FOLDER_LABEL_MAX = 60;
const LabelText = z.string().trim().max(FOLDER_LABEL_MAX, `Keep the label under ${FOLDER_LABEL_MAX} characters`);
// Older operations and callers can write deal records without asking this PC to index a folder.
const IndexHere = z.literal(true).optional();
const FolderInput = z.object({ path: z.string().min(1), label: LabelText, files: z.number().int().nonnegative(), size: z.string() });

/**
 * A deal's name as it is kept: one form of each accented letter (NFC), invisible characters dropped, the spaces at
 * both ends trimmed, and every space inside it as typed.
 */
export const cleanName = (n: string) => n.normalize('NFC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
/**
 * A deal's name as it is compared: the kept form with any run of spaces (non-breaking ones included) as one space. So
 * "Proseware Wind" is the same deal as "Proseware  Wind" and "Proseware Wind" with a non-breaking space, and the name
 * typed to delete a deal matches the one shown, though what is kept is never changed.
 */
export const sameName = (n: string) => cleanName(n).replace(/\s+/g, ' ');
/** the longest name a deal can have, "Project " included, whether it was made or renamed */
export const DEAL_NAME_MAX = 120;
/**
 * The word "Project" at the start of a deal's name, in any capitals, followed by anything but a letter, accent or
 * digit: "Project-Contoso", "Project: Contoso" and "Project" have it, "Projector" and "Project2" do not. Misspellings are
 * left as typed. A pattern's source, used after ^ with the "u" and "i" flags.
 */
export const PROJECT_WORD = String.raw`project(?![\p{L}\p{M}\p{N}])`;
const STARTS_WITH_PROJECT = new RegExp(`^${PROJECT_WORD}`, 'iu');
const startsWithProject = (n: string) => STARTS_WITH_PROJECT.test(n);
/** Remove the same Project word in both uses, keeping meaningful punctuation in display names (#628). */
export function bareDealName(name: string, use: 'display' | 'navigation' = 'display') {
  if (!startsWithProject(name)) return name;
  const suffix = name.slice('Project'.length);
  if (use === 'navigation') return suffix.replace(/^[^\p{L}\p{N}]*/u, '');
  return suffix.replace(/^(?:\s+|[-:–—]\s*)/u, '') || name;
}
/**
 * A deal's name as kept, on a new deal and a rename alike: "Project " goes in front when the name doesn't already start
 * with it; when it does, only that word is written "Project" and the rest stays as typed.
 */
export const withProject = (n: string) => {
  if (!startsWithProject(n)) return `Project ${n}`;
  return `Project${n.slice('project'.length)}`;
};
/** how long a name field lets the person type: a name without "Project", once cleaned as it will be kept, leaves room
 * for the 8 characters it gets */
export const dealNameRoom = (typed: string) => {
  if (startsWithProject(cleanName(typed))) return DEAL_NAME_MAX;
  return DEAL_NAME_MAX - 8;
};

export const CreateDeal = define({
  name: 'CreateDeal',
  input: z.object({
    name: z.string().trim().min(1, 'Give the deal a name'),
    folders: z.array(FolderInput).min(0),
    indexHere: IndexHere,
    counterparty: z.string().trim().max(80, 'Keep it under 80 characters').optional(),
    product: z.string().trim().max(80, 'Keep it under 80 characters').optional(),
    sector: z.string().trim().max(80, 'Keep it under 80 characters').optional(),
    technology: z.string().trim().max(80, 'Keep it under 80 characters').optional(),
  }),
  targets: () => [],
  plan(state, input, ctx) {
    const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
    const seen = new Set<string>();
    for (const f of input.folders) { if (seen.has(norm(f.path))) return fail(rejected(`${f.path} is listed twice`)); seen.add(norm(f.path)); }
    const id = ctx.ids.next('d');
    const name = withProject(cleanName(input.name));
    if (name.length > DEAL_NAME_MAX) return fail(rejected(`Keep the name under ${DEAL_NAME_MAX} characters`));
    // two deals may have the same name: many deals do
    const deal = Deal.parse({
      id, rev: 0, createdAt: ctx.at, updatedAt: ctx.at, name,
      // optional on the New deal form; also set at the top right of the deal page
      counterparty: input.counterparty ?? '',
      product: input.product ?? '', sector: input.sector ?? '', technology: input.technology ?? '',   // picked on the New deal form; their lists' items come with the general list
      stage: input.folders.length ? 'indexing' : 'ready',
      folders: input.folders.map((f) => Folder.parse({ ...f, indexed: 0, reviewed: 0 })),
      log: input.folders.length ? [`Indexing ${input.folders.length} folder${input.folders.length > 1 ? 's' : ''}`] : [],
    });
    return ok({
      dealId: id,
      // the deal goes into the list of the person who created it
      upserts: [{ kind: 'deal', record: deal, expectedRev: null }, { kind: 'member', record: firstMember(id, ctx.actor, ctx.at), expectedRev: null }],
      index: { dealId: '_', add: [{ kind: 'deal', id }, { kind: 'member', id: memberId(id, ctx.actor) }] },
      audit: [{ kind: 'created', recordId: id, dealId: id, text: name }],
      indexFolders: input.indexHere ? deal.folders.map((folder) => folder.path) : undefined,
      message: `${name} created`,
      alwaysSay: input.indexHere,
      messageGlyph: input.indexHere ? 'done' : undefined,
      // the firm's general list goes on the new deal straight after, in an operation of its own: a deal's items are filed
      // under the deal, and this change is filed with the list of deals
      effect: async () => { const items = missingItems(state, deal); return items.length ? { command: 'AddDealItems', input: { dealId: id, items, fresh: true } } : null; },
    });
  },
});

/** A folder path as a key: the same folder written with / or \, in another case, or with a trailing separator, is one key. */
export const pathKey = (p: string): string => p.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
export const folderInside = (path: string, parent: string) => pathKey(path).startsWith(pathKey(parent) + '\\');

/** Why `f` cannot go on beside `folders`: it is inside one of them, or holds one. Null when it overlaps none. */
export function overlap(folders: Folder[], f: { path: string; label?: string }): string | null {
  const name = f.label || f.path;
  const outer = folders.find(({ path }) => folderInside(f.path, path));
  if (outer) return `${name} is inside ${outer.label || outer.path}, already on this deal`;
  const inner = folders.find(({ path }) => folderInside(path, f.path));
  if (inner) return `${inner.label || inner.path}, already on this deal, is inside ${name}`;
  return null;
}

/** Where a folder whose row is `at` (removed rows counted) goes among the folders on the deal: after the ones listed above it. */
function liveAt(d: Pick<Deal, 'removed'>, at: number, path: string, n: number): number {
  const key = pathKey(path);
  return Math.max(0, Math.min(n, at - d.removed.filter((r) => pathKey(r.path) !== key && r.at < at).length));
}

export const AddFolders = define({
  name: 'AddFolders',
  input: z.object({ dealId: DealId, folders: z.array(FolderInput).min(1), indexHere: IndexHere }),
  targets: (_s, i) => [i.dealId],
  plan(state, input, ctx) {
    const d = state.deals[input.dealId];
    if (!d) return fail(notFound('Deal not found', input.dealId));
    const have = new Set(d.folders.map((f) => pathKey(f.path)));
    for (const f of input.folders) { if (have.has(pathKey(f.path))) return fail(rejected(`${f.label || f.path} is already on this deal`)); have.add(pathKey(f.path)); }
    // a folder inside one on the deal, or holding one, would have its documents read twice (the dialog says so first;
    // this holds when a folder was put back while another inside it waited to be added)
    for (const [i, f] of input.folders.entries()) { const o = overlap([...d.folders, ...input.folders.slice(0, i).map((x) => Folder.parse(x))], f); if (o) return fail(rejected(o)); }
    // a removed folder added again is indexed again, in its own row: it is no longer listed as removed, and no row moves
    const folders = [...d.folders]; let removed = d.removed;
    for (const f of input.folders.map((x) => Folder.parse({ ...x, indexed: 0, reviewed: 0 }))) {
      const was = removed.find((r) => pathKey(r.path) === pathKey(f.path));
      if (!was) { folders.push(f); continue; }
      removed = removed.filter((r) => r !== was);
      folders.splice(liveAt({ removed }, was.at, f.path, folders.length), 0, f);
    }
    const deal: Deal = { ...d, stage: 'indexing', folders, removed, updatedAt: ctx.at };
    const paths = input.folders.map((folder) => folder.path);
    return ok({
      dealId: d.id,
      upserts: [{ kind: 'deal', record: deal, expectedRev: d.rev }],
      audit: [{ kind: 'edited', recordId: d.id, dealId: d.id, field: 'folders', to: paths }],
      indexFolders: input.indexHere ? paths : undefined,
      message: `${paths.length} folder${paths.length > 1 ? 's' : ''} added`,
      alwaysSay: input.indexHere,
    });
  },
});

/** Indexing finished (or its final counts changed): the deal is written once, through this command. Progress under way is only shown, never saved. */
export const RecordIndexingProgress = define({
  name: 'RecordIndexingProgress',
  input: z.object({ dealId: DealId, folders: z.array(Folder), log: z.array(z.string()), done: z.boolean() }),
  targets: (_s, i) => [i.dealId],
  plan(state, input, ctx) {
    const d = state.deals[input.dealId];
    if (!d) return fail(notFound('Deal not found', input.dealId));
    // only the folders still on the deal: one a person removed while it was being indexed is not put back
    const got = new Map(input.folders.map((f) => [f.path, f]));
    const folders = d.folders.map((f) => got.get(f.path) ?? f);
    const deal: Deal = { ...d, folders, log: input.log, stage: input.done ? 'ready' : 'indexing', updatedAt: ctx.at };
    return ok({ dealId: d.id, upserts: [{ kind: 'deal', record: deal, expectedRev: d.rev }], audit: [] });
  },
});

/**
 * A person takes a folder off a deal. New checks and questions stop reading its documents; findings already made
 * keep their citations, which still open. The folder stays listed in the Folders dialog, under Removed, with Restore;
 * Restore and Undo put it back where it was, with its counts, and nothing is indexed again.
 */
export const RemoveFolder = define({
  name: 'RemoveFolder',
  input: z.object({ dealId: DealId, path: z.string().min(1) }),
  targets: (_s, i) => [i.dealId],
  plan(state, input, ctx) {
    const d = state.deals[input.dealId];
    if (!d) return fail(notFound('Deal not found', input.dealId));
    const i = d.folders.findIndex((f) => f.path === input.path);
    if (i < 0) return fail(rejected('That folder is no longer on this deal'));
    const f = d.folders[i];
    // where it stood among the deal's folders, removed ones counted, so Restore puts it back there whatever was removed or restored since
    const at = foldersWithRemoved(d).findIndex((r) => !r.gone && r.f.path === f.path);
    const removed = [...d.removed.filter((r) => pathKey(r.path) !== pathKey(f.path)), { ...f, at }];
    const deal: Deal = { ...d, folders: d.folders.filter((_, j) => j !== i), removed, updatedAt: ctx.at };
    return ok({
      dealId: d.id, upserts: [{ kind: 'deal', record: deal, expectedRev: d.rev }],
      audit: [{ kind: 'edited', recordId: d.id, dealId: d.id, field: 'folders', from: f.path }],
      message: `${f.label || f.path} removed`,
      inverse: { command: 'RestoreFolder', input: { dealId: d.id, folder: f, at } },
    });
  },
});

/**
 * A deal's folders with the ones taken off it, each where it stood: the Folders dialog lists the removed ones under
 * Removed, in this order. `at` is the folder's place in this list when it was removed, removed ones counted.
 */
export function foldersWithRemoved(d: Pick<Deal, 'folders' | 'removed'>): { f: Folder; gone?: Deal['removed'][number] }[] {
  const rows: { f: Folder; gone?: Deal['removed'][number] }[] = d.folders.map((f) => ({ f }));
  const on = new Set(d.folders.map((f) => pathKey(f.path)));       // one on the deal again (from another PC, say) is listed once, as on it
  for (const r of [...d.removed].sort((a, b) => a.at - b.at)) if (!on.has(pathKey(r.path))) rows.splice(Math.min(r.at, rows.length), 0, { f: r, gone: r });
  return rows;
}

/** Undo of RemoveFolder, and Restore in the Folders dialog: the folder goes back as it was, in its place. */
export const RestoreFolder = define({
  name: 'RestoreFolder',
  input: z.object({ dealId: DealId, folder: Folder, at: z.number().int().nonnegative(), indexHere: IndexHere }),
  targets: (_s, i) => [i.dealId],
  plan(state, input, ctx) {
    const d = state.deals[input.dealId];
    if (!d) return fail(notFound('Deal not found', input.dealId));
    if (d.folders.some((f) => pathKey(f.path) === pathKey(input.folder.path))) return fail(rejected(`${input.folder.label || input.folder.path} is already on this deal`));
    // a folder added since, inside this one or around it, would have its documents read twice: it says which
    const o = overlap(d.folders, input.folder); if (o) return fail(rejected(o));
    const folders = [...d.folders]; folders.splice(liveAt(d, input.at, input.folder.path, folders.length), 0, input.folder);
    // Only the unread files remain when an unfinished folder is put back.
    const unfinished = input.folder.indexed < input.folder.files;
    const stage = unfinished ? 'indexing' : d.stage;
    const deal: Deal = { ...d, folders, stage, removed: d.removed.filter((r) => pathKey(r.path) !== pathKey(input.folder.path)), updatedAt: ctx.at };
    return ok({
      dealId: d.id, upserts: [{ kind: 'deal', record: deal, expectedRev: d.rev }],
      audit: [{ kind: 'edited', recordId: d.id, dealId: d.id, field: 'folders', to: [input.folder.path] }],
      indexFolders: input.indexHere && unfinished ? [input.folder.path] : undefined,
      message: `${input.folder.label || input.folder.path} restored`,
      inverse: { command: 'RemoveFolder', input: { dealId: d.id, path: input.folder.path } },
    });
  },
});

/** a deal's status, as one deal has it: "Pitch" */
export const GROUP_LABEL: Record<Deal['group'], string> = { live: 'Live', monitor: 'Monitoring', pitch: 'Pitch', closed: 'Closed' };
/** the same statuses as the list on the left names its sections, the deals under each: "Pitches". One name, in the number the place needs. */
export const GROUP_HEADING: Record<Deal['group'], string> = { live: 'Live', monitor: 'Monitoring', pitch: 'Pitches', closed: 'Closed' };

/**
 * A person changes what the deal is called, which group it sits under, or which way new questions run.
 * A rename gets "Project " in front when it doesn't start with it, as a new deal does.
 */
export const EditDeal = define({
  name: 'EditDeal',
  input: z.object({
    dealId: DealId,
    name: z
      .string()
      .transform(cleanName)
      .pipe(z.string().min(1, 'A deal needs a name'))
      .transform(withProject)
      .pipe(z.string().max(DEAL_NAME_MAX, `Keep the name under ${DEAL_NAME_MAX} characters`))
      .optional(),
    group: DealGroup.optional(),
    counterparty: z.string().trim().max(80, 'Keep it under 80 characters').optional(),
    product: z.string().trim().max(80, 'Keep it under 80 characters').optional(),
    sector: z.string().trim().max(80, 'Keep it under 80 characters').optional(),
    technology: z.string().trim().max(80, 'Keep it under 80 characters').optional(),
    /** relabel one folder, named by its path */
    folder: z.object({ path: z.string().min(1), label: LabelText }).optional(),
    /**
     * checklist items turned off or on in the same change: how Undo takes back the items a new structure,
     * sector or technology added
     */
    itemsOff: z.array(ItemId).optional(),
    itemsOn: z.array(ItemId).optional(),
    /** a person picked another list for a layer: the old list's items go off and the new list's come back on */
    swap: z.boolean().optional(),
    /** of itemsOff, those to mark as turned off by a swap: how Undo and Redo keep a swap's mark */
    offBySwap: z.array(ItemId).optional(),
  }),
  targets: (_s, i) => [i.dealId],
  plan(state, input, ctx) {
    const d = state.deals[input.dealId];
    if (!d) return fail(notFound('Deal not found', input.dealId));
    const next = { ...d };
    const before: { name?: string; group?: Deal['group']; counterparty?: string; product?: string; sector?: string; technology?: string; folder?: { path: string; label: string } } = {};
    const said: string[] = [];
    if (input.name !== undefined && input.name !== d.name) {
      before.name = d.name; next.name = input.name; said.push(`Renamed to ${input.name}`);
    }
    if (input.group !== undefined && input.group !== d.group) { before.group = d.group; next.group = input.group; said.push(`${next.name} moved to ${GROUP_HEADING[input.group]}`); }
    if (input.counterparty !== undefined && input.counterparty !== d.counterparty) { before.counterparty = d.counterparty; next.counterparty = input.counterparty; said.push(input.counterparty ? `Counterparty set to ${input.counterparty}` : 'Counterparty cleared'); }
    if (input.product !== undefined && input.product !== d.product) { before.product = d.product; next.product = input.product; said.push(input.product ? `Structure set to ${input.product}` : 'Structure cleared'); }   // the page calls the kind of financing the deal's structure
    if (input.sector !== undefined && input.sector !== d.sector) { before.sector = d.sector; next.sector = input.sector; said.push(input.sector ? `Sector set to ${input.sector}` : 'Sector cleared'); }
    if (input.technology !== undefined && input.technology !== d.technology) { before.technology = d.technology; next.technology = input.technology; said.push(input.technology ? `Technology set to ${input.technology}` : 'Technology cleared'); }
    if (input.folder) {
      const f = d.folders.find((x) => x.path === input.folder!.path);
      if (!f) return fail(notFound('That folder is not on this deal'));
      if (f.label !== input.folder.label) { before.folder = { path: f.path, label: f.label }; next.folders = d.folders.map((x) => (x.path === f.path ? { ...x, label: input.folder!.label } : x)); said.push(input.folder.label ? `Folder labeled ${input.folder.label}` : 'Folder label cleared'); }
    }
    if (!said.length) return ok({ dealId: d.id, upserts: [], audit: [] });
    next.updatedAt = ctx.at;
    // A new structure, sector or technology adds the items of its list that the deal does not hold, in the same change
    // (linking design, section 5). Nothing is taken off. Only on a deal whose items this window holds: on one it does not,
    // the Checklist page offers "Add them" once it is opened.
    const layerChanged = (['product', 'sector', 'technology'] as const).some((k) => k in before && key(next[k]) !== key(d[k]));
    const add = layerChanged && state.dealLoad[d.id] === 'loaded' ? addItems(state, d.id, missingItems(state, next), ctx) : { upserts: [], ids: [] };
    // A swap (a person picking another list): the items only the old list brought go off, and the new list's items that
    // are on the deal but off come back on (domain/checklist leftBehind, turnedOffIn). Undo's inverse names them all.
    const autoOff: string[] = []; const autoOn: string[] = [];
    if (input.swap && layerChanged && state.dealLoad[d.id] === 'loaded') {
      const firm = usableFirm(state); const anyVersion = usableFirm(state, true); const mine = Object.values(state.items).filter((i) => i.dealId === d.id);
      for (const k of ['product', 'sector', 'technology'] as const) {
        if (!(k in before)) continue;
        const gone = leftBehind(anyVersion, mine, d, k, next[k]).map((i) => i.id); autoOff.push(...gone);
        autoOn.push(...turnedOffIn(firm, mine, d, k, next[k]).map((i) => i.id));
      }
    }
    const off = setOff(state, [...new Set([...(input.itemsOff ?? []), ...autoOff])], true, ctx, new Set([...(input.offBySwap ?? []), ...autoOff])); if (!off.ok) return off;
    const on = setOff(state, [...new Set([...(input.itemsOn ?? []), ...autoOn])], false, ctx); if (!on.ok) return on;
    if (autoOff.length) said.push(`${autoOff.length} ${autoOff.length === 1 ? 'item' : 'items'} off`);   // short: a toast is one line
    const added = add.ids.length + autoOn.length;   // added, or back on: either way now on the deal's checklist
    if (added) said.push(input.swap ? `${added} added` : `${added} checklist ${added === 1 ? 'item' : 'items'} added`);
    return ok({
      dealId: d.id,
      upserts: [{ kind: 'deal', record: next, expectedRev: d.rev }, ...add.upserts, ...off.value.upserts, ...on.value.upserts],
      ...(add.ids.length ? { index: { dealId: d.id, add: add.ids.map((id) => ({ kind: 'item' as const, id })) } } : {}),
      audit: [{ kind: 'edited', recordId: d.id, dealId: d.id, text: said.join('; ') }],
      // Undo turns off what this added or turned on; those a swap brought, or that were off by a swap before, keep that mark
      inverse: { command: 'EditDeal', input: { dealId: d.id, ...before, itemsOff: [...add.ids, ...on.value.changed], itemsOn: off.value.changed,
        offBySwap: [...(input.swap ? add.ids : []), ...on.value.changed.filter((id) => state.items[id]?.offBySwap)] } },
      message: said.join(' · '),
    });
  },
});

export const matchesDealName = (typed: string, name: string) => sameName(typed) === sameName(name);

export const DeleteDeal = define({
  name: 'DeleteDeal',
  // `seen`: what this PC had taken in when the person began deleting (Repository.seen): work from another PC that arrives
  // while they confirm was never in front of them, so that PC keeps it
  input: z.object({ dealId: DealId, typedName: z.string(), seen: z.record(z.string(), z.array(z.tuple([z.number(), z.number()]))).optional() }),
  targets: (_s, i) => [i.dealId],
  plan(state, input, ctx) {
    const d = state.deals[input.dealId];
    if (!d) return fail(notFound('Deal not found', input.dealId));
    if (!matchesDealName(input.typedName, d.name)) return fail(rejected('Type the deal name exactly to delete it'));
    const tomb = Tombstone.parse({ kind: 'deal', dealId: d.id, id: d.id, title: d.name, at: ctx.at, actor: ctx.actor, snapshot: d });
    return ok({
      dealId: d.id,
      upserts: [{ kind: 'tombstone', record: tomb, expectedRev: null }],
      removes: [{ kind: 'deal', id: d.id, rev: d.rev }, ...Object.values(state.members).filter((m) => m.dealId === d.id).map((m) => ({ kind: 'member' as const, id: m.id, rev: m.rev }))],   // and it leaves everyone's list
      // what the dialog promises: its findings, its Q&A log and their history go with it. A person confirmed twice; there is no Undo.
      purgeDeal: d.id,
      ...(input.seen ? { seen: input.seen } : {}),
      index: { dealId: '_', remove: [{ kind: 'deal', id: d.id }], add: [{ kind: 'tombstone', id: d.id }] },
      audit: [],
      message: `${d.name} deleted`,
    });
  },
});
