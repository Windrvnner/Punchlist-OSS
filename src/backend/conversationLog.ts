/**
 * Conversations kept in the synced folder, so a person who starts one at the office picks it up at home.
 *
 *   shared (synced) folder   talk-<install id>-<number>.jsonl   this PC's lines: one finished message each
 *   local folder             talk-<install id>-<number>.jsonl   a full copy of the same, put back if the sync loses lines
 *
 * A line is { v: 1, pc, seq, at, by, key, m }: `by` is the person, `key` the conversation (`deal:<id>:<conv>`, `f:…`, …)
 * and `m` the message. A message is never edited in place: an answer retried is written again under the same id, and the
 * newest line for an id wins. Only finished messages are written; one still waiting for its answer stays in the window.
 * Every PC reads every `talk-*.jsonl` file, and returns only the conversations of the person signed in. The files are
 * readable by anyone with the folder, as the deal records are (nothing in them is privileged).
 *
 * Kept apart from the record files on purpose: a conversation is one person's, never a shared record, and never needs a
 * person to choose between versions. Two PCs adding to the same conversation each keep their messages.
 */
import type { Folder } from './logRepository';
import type { ConversationStore, KeptMessage } from '../ports';
import { ok, fail } from '../domain/result';
import { appendOwn, healOwn, holdsFailedAppend, wholeLines } from './ownFile';

export interface ConversationLogOptions {
  shared: Folder; local: Folder;
  /** this install's id (the repository's) */
  installId: string;
  /** the person signed in */
  user: () => string;
  clock?: () => string;
  /** a file this big is finished with and the next one started (default 1 MB) */
  segmentBytes?: number;
  /** how often another PC's lines are looked for while something is watching (default 5 s) */
  pollMs?: number;
}

interface Line { v: 1; pc: string; seq: number; at: string; by: string; key: string; m: KeptMessage }
const FILE = /^talk-(.+)-(\d+)\.jsonl$/;
const later = (a: Line, b: Line) => (a.at !== b.at ? a.at > b.at : a.pc !== b.pc ? a.pc > b.pc : a.seq > b.seq);
/** the same message, whatever order its fields come in (a window that read it back may have reordered them) */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const same = (a: KeptMessage, b: KeptMessage) => canon(a) === canon(b);

export function conversationLog(o: ConversationLogOptions): ConversationStore & { close(): void } {
  const clock = o.clock ?? (() => new Date().toISOString());
  const limit = o.segmentBytes ?? 1_000_000;
  /** what has been read of each file: its size, so an unchanged file is not opened again (shared, and this PC's local copy) */
  const seen = new Map<string, number>(); const seenLocal = new Map<string, number>();
  /** every line read, once each (`pc.seq`): only its id is kept, so the other people's messages are not held in memory */
  const ids = new Set<string>();
  /** person → conversation → message id → its newest line; only the person signed in (`heldFor`) has any */
  const byPerson = new Map<string, Map<string, Map<string, Line>>>(); let heldFor: string | undefined;
  let seq = -1; let file = 0;

  const own = (n: number) => `talk-${o.installId}-${n}.jsonl`;
  const take = (l: Line) => {
    const id = `${l.pc}.${l.seq}`; if (ids.has(id)) return false;
    ids.add(id);
    if (l.pc === o.installId) seq = Math.max(seq, l.seq);
    if (l.by !== heldFor) return false;
    let convs = byPerson.get(l.by); if (!convs) byPerson.set(l.by, (convs = new Map()));
    let msgs = convs.get(l.key); if (!msgs) convs.set(l.key, (msgs = new Map()));
    const cur = msgs.get(l.m.id); if (!cur || later(l, cur)) { msgs.set(l.m.id, l); return true; }
    return false;
  };
  const parse = (text: string) => {
    const out: Line[] = [];
    // a line cut short by a crash or a sync caught part-way has no line end: not there yet
    for (const raw of wholeLines(text)) {
      try { const l = JSON.parse(raw); if (l && l.v === 1 && typeof l.pc === 'string' && Number.isInteger(l.seq) && typeof l.by === 'string' && typeof l.key === 'string' && l.m && typeof l.m.id === 'string' && (l.m.role === 'me' || l.m.role === 'ai') && typeof l.m.text === 'string' && (l.m.state === 'done' || l.m.state === 'failed') && typeof l.at === 'string') out.push(l); }
      catch { /* a damaged line is passed over; the others in the file still count */ }
    }
    return out;
  };
  /** Pass each line of one file to `each`, unless the file is missing or its size is the one in `sizes` from the last read: an unchanged file is not opened. */
  const readChanged = (folder: Folder, sizes: Map<string, number>, name: string, each: (l: Line) => void) => {
    const size = folder.size(name); if (size < 0 || sizes.get(name) === size) return;
    for (const l of parse(folder.read(name) ?? '')) each(l);
    sizes.set(name, size);
  };
  /** Read whatever has changed. Returns whether anything new for the person signed in arrived. */
  const refresh = () => {
    const me = o.user(); let mine = false;
    // another person signed in: everything is read again for them (it is rare, and only their lines are kept)
    if (me !== heldFor) { ids.clear(); byPerson.clear(); seen.clear(); seenLocal.clear(); heldFor = me; }
    // this PC's own files first: lines the sync lost are put back from the local copy
    for (const name of o.local.list()) { const m = FILE.exec(name); if (m && m[1] === o.installId) { healOwn(o.shared, o.local, name); file = Math.max(file, +m[2]); } }
    // a shared folder that cannot be read now costs only the other PCs' lines: this PC's are read from its own copy below
    let names: string[] = []; try { names = o.shared.list(); } catch { /* looked at again next time */ }
    for (const name of names) if (FILE.test(name)) { try { readChanged(o.shared, seen, name, (l) => { if (take(l) && l.by === me) mine = true; }); } catch { /* read again next time */ } }
    // and what only the local copy holds (the shared folder could not be read)
    // (not a failed save's lines while they cannot be cut off yet: they would count as saved and not be saved again)
    for (const name of o.local.list()) {
      const m = FILE.exec(name);
      if (m && m[1] === o.installId && !holdsFailedAppend(o.local, name)) readChanged(o.local, seenLocal, name, take);
    }
    return mine;
  };
  const threads = (): Record<string, KeptMessage[]> => {
    const out: Record<string, KeptMessage[]> = {};
    for (const [key, msgs] of byPerson.get(o.user()) ?? []) {
      // in the order they were said: by when, a question before its answer, then in the order written
      out[key] = [...msgs.values()].sort((a, b) => (a.m.at !== b.m.at ? (a.m.at < b.m.at ? -1 : 1) : a.m.role !== b.m.role ? (a.m.role === 'me' ? -1 : 1) : a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.seq - b.seq)).map((l) => l.m);
    }
    return out;
  };
  const why = (e: unknown) => ((e as { code?: string })?.code === 'ENOSPC' ? fail({ kind: 'storageFull' as const, message: 'The disk is full' }) : fail({ kind: 'unreachable' as const, message: 'The Punchlist folder could not be written' }));

  let timer: ReturnType<typeof setInterval> | null = null; const watchers = new Set<() => void>();
  return {
    async load() {
      try { refresh(); return ok(threads()); } catch { return fail({ kind: 'unreachable', message: 'The Punchlist folder could not be read' }); }
    },
    async save(key, messages) {
      const before = seq;
      try {
        refresh();
        const me = o.user(); const have = byPerson.get(me)?.get(key);
        const fresh = messages.filter((m) => (m.state === 'done' || m.state === 'failed') && !(have?.get(m.id) && same(have.get(m.id)!.m, m)));
        if (!fresh.length) return ok(undefined);
        const at = clock();
        const out = fresh.map((m) => ({ v: 1 as const, pc: o.installId, seq: ++seq, at, by: me, key, m }));
        const text = out.map((l) => JSON.stringify(l)).join('\n') + '\n';
        if (o.local.size(own(file)) > 0 && o.local.size(own(file)) + text.length > limit) file++;
        // kept on this PC even when the shared folder refuses it: the next look at the folder (`refresh`) shares it
        const refused = appendOwn(o.shared, o.local, own(file), text, true);
        for (const l of out) take(l);
        if (refused) return why(refused);
        seen.set(own(file), o.shared.size(own(file)));
        return ok(undefined);
      } catch (e) {
        // this PC's copy could not be written, so nothing was, anywhere: the numbers are used again, and the failure says so (`failed`)
        seq = before;
        return fail({ kind: 'failed' as const, message: (e as { code?: string })?.code === 'ENOSPC' ? 'The disk is full' : 'This PC’s copy of the conversation could not be written' });
      }
    },
    watch(onChange) {
      watchers.add(onChange);
      timer ??= setInterval(() => { try { if (refresh()) for (const w of watchers) w(); } catch { /* looked for again at the next tick */ } }, o.pollMs ?? 5000);
      return () => { watchers.delete(onChange); if (!watchers.size && timer) { clearInterval(timer); timer = null; } };
    },
    close() { if (timer) clearInterval(timer); timer = null; watchers.clear(); },
  };
}
