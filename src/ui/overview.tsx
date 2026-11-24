import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useAppState, useStore } from './hooks';
import type { Layer } from '../domain/checklist';
import { Icon } from './icons';
import { AI_LABEL } from '../control';
import type { Deal } from '../domain/model';
import { askAbout, dealHash, dealTwin, type UiState } from '../app/state';
import { checklistListCounts, checklistStandingCounts, findingCounts, questionCounts } from '../app/dealCounts';
import { folderProgress, overviewStatus } from '../app/indexing';
import { openLocate } from '../app/relink';
import { PageTop, Stalled, NoRoom, INDEXING_LINE, INDEXING_TIP, useDealLock } from './deal';
import { EditField, ReadOnlyContext, readDeal } from './editField';
import { EditDeal } from '../app/commands/deals';
import { CheckLine } from './findings';
import { PickList, type PickName } from './pickList';
import { AskFirst } from './dialogs';
import { previewSwap } from '../app/checklistImport';
import { num } from './counts';

/**
 * The page a deal opens on unless the person chose another in Settings: how the findings, the checklist and the
 * questions stand, side by side; Check again, only when a check is due; the gaps in the documents; and how far the
 * documents have been indexed and read.
 */
export function OverviewPage({ dealId }: { dealId: string }) {
  const store = useStore(); const s = useAppState();
  const d = s.deals[dealId];
  useEffect(() => { void store.loadDeal(dealId); void store.refreshChecklist(dealId); }, [dealId]);   // the checklist's rows say what each gap needs
  if (!d) return null;
  const { waiting, noRoom, showIndexing, gaps } = overviewStatus(s, d);
  return (
    <div class="home top wide">
      <PageTop deal={d} route="overview" placeholder={askAbout(d.name)} />
      <Details deal={d} />
      <Stalled deal={d} />
      {noRoom ? <NoRoom deal={d} /> : <>
        {!waiting && <Standing deal={d} />}
        {!waiting && <CheckLine deal={d} />}
        <section class={`twocol ov ${gaps.length ? '' : 'solo'} ${waiting ? 'first' : 'under'}`}>
          {gaps.length > 0 && <div><div class="lbl flagsl"><span role="heading"
            aria-level={2}>Gaps in the Documents</span></div><ul class="gaps linked">{gaps.map((g) => <li key={g.key}><a
            href={`#checklist-${d.id}`} onClick={() => store.ui({ checklistFilter: 'gap' })}>{g.title}</a>{g.need &&
            <span>{g.need}</span>}</li>)}</ul></div>}
          <div><Documents deal={d} /></div>
        </section>
        {showIndexing && <p class="emptyline" title={INDEXING_TIP}>{INDEXING_LINE}</p>}
      </>}
    </div>
  );
}

/**
 * What kind of deal it is: its structure, its sector and its technology, each after its name, in the same three
 * columns as the blocks beneath. They say which checklists apply. They are here and not in every page's header: they
 * are set once and seldom change.
 */
function Details({ deal: d }: { deal: Deal }) {
  const store = useStore(); const locked = useDealLock(d);
  const s = useAppState();
  // A layer the firm has lists for is a pick list of them; one it has none for stays free text.
  const field = (label: string, k: 'product' | 'sector' | 'technology') => {
    const names = checklistListCounts(s, k);
    return (<div><div class="k" id={`ovf-${k}-l`}>{label}</div>{names.length ? <PickField deal={d} field={k} label={label} names={names} />
      : <EditField keep={`${d.id}:${k}`} read={readDeal(d.id, k)} label={label} placeholder="Not set" className="edit inl" cap={{}} value={d[k]} rev={d.rev} maxLength={80} commit={(v, over) => store.dispatch(EditDeal, { dealId: d.id, [k]: v }, { quiet: true, over })} />}</div>);
  };
  return <section class="ovfacts" id="ov-details" aria-label="Deal details"><ReadOnlyContext.Provider value={locked}>{field('Structure', 'product')}{field('Sector', 'sector')}{field('Technology', 'technology')}</ReadOnlyContext.Provider></section>;
}

/**
 * A deal's structure, sector or technology, picked from the firm's lists for that layer. Picking swaps lists: the new
 * list's items are added or come back on, and those only the old list brought go off. When items would go
 * off it asks first, with how many go off and come on; otherwise it just happens. Undo still takes it all back.
 */
function PickField({ deal: d, field, label, names }: { deal: Deal; field: Layer & ('product' | 'sector' | 'technology'); label: string; names: PickName[] }) {
  const store = useStore(); const locked = useContext(ReadOnlyContext);
  const [ask, setAsk] = useState<{ to: string; off: number; on: number } | null>(null);
  const swap = (v: string) => void store.dispatch(EditDeal, { dealId: d.id, [field]: v, swap: true });
  const pick = (v: string) => { const n = previewSwap(store, d.id, field, v); if (n && n.off > 0) setAsk({ to: v, ...n }); else swap(v); };
  const items = (n: number) => `${n.toLocaleString('en-US')} checklist ${n === 1 ? 'item goes' : 'items go'}`;
  return <>
    <PickList id={`pick-${field}`} className="pickbtn" chev label={label} names={names} cur={d[field]} end={field === 'technology'} disabled={!!locked} title={locked ?? 'Picking a list swaps its items in'} onPick={pick} />
    {ask && <AskFirst ask={ask.to ? `Switch ${label} to ${ask.to}?` : `Clear ${label}?`} text={`${items(ask.off)} off${ask.on ? ` and ${ask.on.toLocaleString('en-US')} ${ask.on === 1 ? 'comes' : 'come'} on` : ''}.`} go={ask.to ? 'Switch' : 'Clear'}
      onKeep={() => setAsk(null)} onGo={() => { const to = ask.to; setAsk(null); swap(to); }} />}
  </>;
}

/**
 * How the deal stands, in three columns side by side: the findings, the checklist and the questions
 * (leader lines, side by side). Each is one bar in three parts, what is open, what is in progress and what is done,
 * with each part's words on a leader line from it. The heading opens its page; every figure opens its page showing what
 * it counts.
 */
function Standing({ deal: d }: { deal: Deal }) {
  const store = useStore(); const s = useAppState();
  const findings = findingCounts(s, d.id);
  const questions = questionCounts(s, d.id);
  const c = useMemo(() => checklistStandingCounts(s, d.id), [
    d.id, s.progress[d.id], s.checklists[d.id], s.items, s.findings, s.conflicts, s.tombstones, s.dealLoad[d.id],
  ]);
  const ff = (status: 'open' | 'reassess' | 'closed') => () => store.ui({ findingFilter: { ...store.get().ui.findingFilter, status } });
  const cf = (checklistFilter: UiState['checklistFilter']) => () => store.ui({ checklistFilter });
  const qf = (status: 'open' | 'answered' | 'closed') => () => store.ui({ qaFilter: { ...store.get().ui.qaFilter, status } });
  const lines: Line[] = [
    {
      id: 'ov-findings', title: 'Findings', href: `#deal-${d.id}`, go: ff('open'), total: findings.total,
      segs: [
        { k: 'open', n: findings.open, word: 'open', go: ff('open'),
          sub: [['may be out of date', findings.reassess, ff('reassess')]] },
        { k: 'done', n: findings.closed, word: 'closed', go: ff('closed') },
      ],
    },
    ...(c ? [checklistLine(d.id, c, cf)] : []),
    {
      id: 'ov-qa', title: 'Q&A', href: `#qa-${d.id}`, go: qf('open'), total: questions.total,
      segs: [
        { k: 'open', n: questions.open, word: 'open', go: qf('open') },
        { k: 'prog', n: questions.answered, word: 'answered', go: qf('answered') },
        { k: 'done', n: questions.closed, word: 'closed', go: qf('closed') },
      ],
    },
  ];
  return <section class="ovstat" id="ov-standing">{lines.map((l) => <Leaders key={l.id} line={l} />)}</section>;
}

type Seg = { k: 'open' | 'prog' | 'done'; n: number; word: string; go?: () => void; sub?: [string, number, () => void][] };
type Line = {
  id: string; title: string; href: string; go: () => void; segs: Seg[]; total: number; off?: [string, () => void];
};

function checklistLine(
  dealId: string, counts: NonNullable<ReturnType<typeof checklistStandingCounts>>,
  filter: (kind: UiState['checklistFilter']) => () => void,
): Line {
  const offLabel = `${num(counts.off)} turned off`
    + (counts.offOpen ? `, ${num(counts.offOpen)} with an open finding` : '');
  return {
    id: 'ov-checklist', title: 'Checklist', href: `#checklist-${dealId}`, go: filter('all'), total: counts.all,
    off: counts.off ? [offLabel, filter('off')] : undefined,
    segs: [
      { k: 'open', n: counts.toResolve, word: 'to resolve', go: filter('all'), sub: [
        ['flagged', counts.finding, filter('finding')],
        [counts.gap === 1 ? 'gap' : 'gaps', counts.gap, filter('gap')],
        [counts.gone === 1 ? 'finding deleted' : 'findings deleted', counts.gone, filter('gone')],
      ] },
      { k: 'prog', n: counts.open, word: 'not settled', go: filter('open') },
      counts.person ? { k: 'done', n: counts.settled, word: 'settled', sub: [
        ['satisfied', counts.satisfied, filter('satisfied')], ['by a person', counts.person, filter('person')],
      ] } : { k: 'done', n: counts.satisfied, word: 'satisfied', go: filter('satisfied') },
    ],
  };
}
type Placed = { lx: number; up: boolean; mode: 'r' | 'l' | 'c'; x: number; w: number; bare?: boolean };
const LEAD: Record<Seg['k'], string> = { open: 'var(--high)', prog: 'var(--accent)', done: 'var(--bar-ix)' };
// a done part's leader is drawn in --ink-3: a 2px line in the bar's own translucent gray is too faint to follow
const STROKE: Record<Seg['k'], string> = { ...LEAD, done: 'var(--ink-3)' };

/**
 * Where each part's words go: above or below the bar, to the right or left of its leader, always on the same hooked
 * leader (one shape, flipped); only where neither side has room are the words centered on a straight leader. Every placing
 * is tried and the one with the fewest overlaps wins; below, to the right, is preferred.
 */
function place(items: { x: number; w: number }[], W: number): Placed[] {
  const opts: { up: boolean; mode: Placed['mode'] }[] = []; for (const up of [true, false]) for (const mode of ['r', 'l', 'c'] as const) opts.push({ up, mode });
  let best: { bad: number; pl: Placed[] } | null = null; const acc: Placed[] = [];
  const score = () => { let bad = 0;
    for (let a = 0; a < acc.length; a++) for (let b = a + 1; b < acc.length; b++) { const A = acc[a], B = acc[b]; if (A.up !== B.up) continue;
      if (A.lx < B.lx + B.w + 12 && B.lx < A.lx + A.w + 12) bad += 1000;                                            // two labels touch
      if ((B.x > A.lx - 4 && B.x < A.lx + A.w + 4) || (A.x > B.lx - 4 && A.x < B.lx + B.w + 4)) bad += 1000; }        // a leader runs through a label
    for (const p of acc) { if (p.lx < -1 || p.lx + p.w > W + 1) bad += 1000; if (p.up) bad += 4; if (p.mode === 'l') bad += 1; if (p.mode === 'c') bad += 500; }
    return bad; };
  const rec = (i: number) => {
    if (i === items.length) { const bad = score(); if (!best || bad < best.bad) best = { bad, pl: acc.slice() }; return; }
    const it = items[i];
    for (const o of opts) { acc.push({ ...it, ...o, lx: o.mode === 'r' ? it.x + 7 : o.mode === 'l' ? it.x - 7 - it.w : Math.min(Math.max(0, it.x - it.w / 2), W - it.w) }); rec(i + 1); acc.pop(); }
  };
  rec(0); return best!.pl;
}
/**
 * The placing with every part's words in full. Where they cannot all fit apart, what a part is made of goes to its
 * hover for as few parts as will make room, so the counts always show and the rest keep their words.
 */
function placeAll(items: { x: number; w: number; bare: number }[], W: number): Placed[] {
  const can = items.map((it, i) => (it.bare < it.w - 1 ? i : -1)).filter((i) => i >= 0);       // the parts that have something to give up
  const masks = Array.from({ length: 1 << can.length }, (_, m) => m).sort((a, b) => bits(a) - bits(b));
  let last: Placed[] = [];
  for (const m of masks) {
    const bare = new Set(can.filter((_, j) => m & (1 << j)));
    last = place(items.map((it, i) => ({ x: it.x, w: bare.has(i) ? it.bare : it.w })), W).map((p, i) => ({ ...p, bare: bare.has(i) }));
    if (!overlaps(last, W)) return last;
  }
  // nothing fits apart (a very narrow column): every label is kept inside its column, cut with "…" if it must be, so none runs into the next
  return last.map((p) => ({ ...p, w: Math.min(p.w, W), lx: Math.min(Math.max(0, p.lx), Math.max(0, W - p.w)) }));
}
const bits = (m: number) => { let n = 0; for (; m; m &= m - 1) n++; return n; };
const overlaps = (pl: Placed[], W: number) => pl.some((A, a) => A.lx < -1 || A.lx + A.w > W + 1 || pl.some((B, b) => b > a && A.up === B.up && ((A.lx < B.lx + B.w + 12 && B.lx < A.lx + A.w + 12) || (B.x > A.lx - 4 && B.x < A.lx + A.w + 4) || (A.x > B.lx - 4 && A.x < B.lx + B.w + 4))));

/** One column: its heading and total, its bar, and each part's words on a leader line from the part. Placed once the words can be measured, and again when the column's width changes. */
function Leaders({ line: l }: { line: Line }) {
  const shown = l.segs.filter((g) => g.n > 0);
  const col = useRef<HTMLDivElement>(null); const [laid, setPl] = useState<{ at: Placed[]; top: number; bot: number; key: string } | null>(null);
  const key = shown.map((g) => `${g.k}${g.n}${g.word}${(g.sub ?? []).map(([w, n]) => w + n).join()}`).join('|');
  const pl = laid?.key === key ? laid : null;            // a placing made for other parts is not used while the new one is worked out
  useLayoutEffect(() => {
    const el = col.current; if (!el) return;
    // each label is measured in full (what it is made of shown, even if hidden for want of room) and bare (its count alone)
    const lay = () => { el.classList.add('measuring'); const c = el.getBoundingClientRect(); const bar = el.querySelector('.pbar')!.getBoundingClientRect();
      const parts = [...el.querySelectorAll<HTMLElement>('.pbar b[data-i]')].map((b) => { const r = b.getBoundingClientRect(); const lab = el.querySelector<HTMLElement>(`.plab[data-i="${b.dataset.i}"]`)!; return { x: r.left + r.width / 2 - c.left, w: lab.getBoundingClientRect().width, bare: lab.firstElementChild!.getBoundingClientRect().width }; });
      el.classList.remove('measuring');
      setPl(parts.length ? { at: placeAll(parts, c.width), top: bar.top - c.top, bot: bar.bottom - c.top, key } : null); };
    lay(); const ro = new ResizeObserver(lay); ro.observe(el); return () => ro.disconnect();
  }, [key]);
  const totalLabel = `${num(l.total)} in all`;
  return (
    <div class="pcol" id={l.id} ref={col}>
      <div class="phead">
        <span role="heading" aria-level={2}>
          <a class="nm" href={l.href} onClick={l.go}>{l.title}<Icon name="chevr" size={12} /></a>
        </span>
        <span class="tot" title={l.off ? `${totalLabel} · ${l.off[0]}` : undefined}>
          {totalLabel}{l.off && <> · <a href={l.href} onClick={l.off[1]}>{l.off[0]}</a></>}
        </span>
      </div>
      <div class="plabs up" />
      <div class="pbar" title={shown.map((g) => `${num(g.n)} ${g.word}`).join(', ') || undefined}>
        {shown.length ? shown.map((g, i) => <b key={i} data-i={i} style={{ flex: g.n, background: LEAD[g.k] }} />)
          : <b class="none" />}
      </div>
      <div class="plabs" />
      {!shown.length && <span class="plab nil">None yet</span>}
      {shown.map((g, i) => { const at = pl?.at[i]; const y = at ? (at.up ? pl!.top - 19 : pl!.bot + 15) : 0;
        const made = (g.sub ?? []).filter(([, k]) => k > 0);
        return <span key={i} data-i={i} class={`plab ${g.k} ${at?.bare ? 'bare' : ''}`}
          title={at?.bare && made.length ? made.map(([w, k]) => `${num(k)} ${w}`).join(' · ') : undefined}
          style={at ? { left: `${at.lx}px`, top: `${y - 9}px`, maxWidth: `${Math.ceil(at.w) + 1}px` }
            : { visibility: 'hidden' }}>
          {/* "settled" has no filter of its own: its count is words, and what it is made of each opens its own */}
          {g.go ? <a class={g.k === 'open' ? 'lo' : ''} href={l.href} onClick={g.go}>{num(g.n)} {g.word}</a>
            : <span class="pn">{num(g.n)} {g.word}</span>}
          {made.map(([w, k, go]) => <span class="sub" key={w}>
            {' · '}<a href={l.href} onClick={go}>{num(k)} {w}</a>
          </span>)}
        </span>; })}
      <svg class="ld" aria-hidden="true">{pl && pl.at.map((at, i) => { const y = at.up ? pl.top - 19 : pl.bot + 15; const y0 = at.up ? pl.top - 2 : pl.bot + 2;
        return at.mode === 'c' ? <path key={i} d={`M${at.x} ${y0} V${at.up ? y + 10 : y - 10}`} fill="none" stroke={STROKE[shown[i].k]} stroke-width="2" />
          : <path key={i} d={`M${at.x} ${y0} V${y} H${at.mode === 'r' ? at.lx - 3 : at.lx + at.w + 3}`} fill="none" stroke={STROKE[shown[i].k]} stroke-width="2" stroke-linejoin="round" />; })}</svg>
    </div>
  );
}

const READ_TIP = `Read: given to the ${AI_LABEL} when a checklist item is checked. The rest are indexed,`
  + ' and searched when a question needs them.';
const EMPTY_TIP = 'The folder opens but has no files. Its documents stay in the deal. '
  + 'Locate it if it moved, or remove it under Folders.';
const EMPTIES_TIP = 'These folders open but have no files. Their documents stay in the deal. '
  + 'Locate them if they moved, or remove them under Folders.';
const pct = (n: number, of: number) => (of > 0 ? Math.min(100, Math.max(n ? 1 : 0, 100 * n / of)) : 0);

type FolderProgress = ReturnType<typeof folderProgress>;
type FolderRow = FolderProgress['rows'][number];
type FolderNotice = { kind: 'away' | 'empty'; label?: string; tip?: string };

function emptyFolderNotice(emptyCount: number, folderCount: number): FolderNotice {
  return {
    kind: 'empty',
    label: emptyCount === folderCount ? 'Files not found' : `Files not found in ${num(emptyCount)}`,
    tip: emptyCount > 1 ? EMPTIES_TIP : EMPTY_TIP,
  };
}

function folderNotice(row: FolderRow, progress: FolderProgress): FolderNotice | undefined {
  const { awayCount, emptyCount, folderCount, total } = progress;
  const summary = !row.key;
  const showLabel = summary || !total;
  if (awayCount) {
    if (row.empty) return { kind: 'empty', label: 'Files not found', tip: EMPTY_TIP };
    if (!summary && !row.away) return undefined;
    if (!showLabel) return { kind: 'away' };
    const label = awayCount === folderCount ? 'Not on this PC' : `${num(awayCount)} not on this PC`;
    return { kind: 'away', label };
  }
  if (!emptyCount || (!summary && !row.empty)) return undefined;
  return showLabel ? emptyFolderNotice(emptyCount, folderCount) : { kind: 'empty' };
}

function documentStatus(row: FolderRow, stopped: boolean) {
  if (row.indexing) {
    const status = `${num(row.indexed)} of ${num(row.files)} indexed`;
    if (!stopped) return status;
    return `${status} · ${row.indexed ? 'stopped' : 'not started'}`;
  }
  return row.read === undefined ? `${num(row.files)} indexed` : `${num(row.read)} of ${num(row.docs)} read`;
}

function FolderDocumentBar({ row, live }: { row: FolderRow; live: boolean }) {
  return <span class="fbar">
    <i class={`ix ${live ? 'live' : ''} ${row.indexed ? 'some' : ''}`}
      style={{ width: `${pct(row.indexed, row.files)}%` }} />
    <i class={`rv ${row.read ? 'some' : ''}`} style={{ width: `${pct(row.read ?? 0, row.docs)}%` }} />
  </span>;
}

function FolderDocumentRow({ row, progress }: { row: FolderRow; progress: FolderProgress }) {
  const className = `dcrow ${row.key && progress.total ? 'part' : ''}`;
  const notice = folderNotice(row, progress);
  const title = row.title || undefined;
  if (notice) {
    const marker = notice.kind === 'away' ? { 'data-away': '' } : { 'data-empty': '' };
    return <div class={className} data-folder={row.key} {...marker}>
      <span class="fn awayfn" title={title}>{row.name}</span>
      <span class={`rd ${notice.label ? 'away' : ''}`} title={notice.tip}>{notice.label}</span>
    </div>;
  }
  const live = row.indexing && !progress.stopped;
  const status = documentStatus(row, progress.stopped);
  const countingReads = row.read !== undefined;
  return <div class={className} data-folder={row.key}>
    <span class="fn" title={title}>{row.name}{row.copies > 0 &&
      <span class="copies">{`${num(row.copies)} ${row.copies === 1 ? 'copy' : 'copies'} counted once`}</span>}</span>
    <FolderDocumentBar row={row} live={live} />
    <span class="rd" title={countingReads ? READ_TIP : undefined}>{status}</span>
  </div>;
}

function CoreDocumentRow({ core }: { core: FolderProgress['core'] }) {
  if (!core.files) return null;
  if (core.unavailable) {
    return <div class="dcrow" id="ov-core" data-away="">
      <span class="fn awayfn">Core documents</span>
      <span class="rd">{core.unavailable === core.files
        ? '' : `${num(core.unavailable)} of ${num(core.files)} not on this PC`}</span>
    </div>;
  }
  return <div class="dcrow" id="ov-core">
    <span class="fn">Core documents</span>
    <span class="fbar">
      <i class={`rv ${core.read ? 'some' : ''}`} style={{ width: `${pct(core.read, core.files)}%` }} />
    </span>
    <span class="rd" title={READ_TIP}>{num(core.read)} of {num(core.files)} read</span>
  </div>;
}

/**
 * The deal's folders, how far each has been indexed, and how many of its documents have been read once indexed.
 * The dark part of a line is what has been read. Core documents are chosen across the whole deal.
 */
function Documents({ deal: d }: { deal: Deal }) {
  const store = useStore();
  const s = useAppState();
  const progress = folderProgress(s, d);
  const { rows, total, folderCount, awayCount, emptyCount, core, alsoIn } = progress;
  const display = total
    ? [{ ...total, key: '', name: `${folderCount} folders`, title: '', away: false, empty: false }, ...rows]
    : rows;
  return <>
    <div class="lbl flagsl">
      <span role="heading" aria-level={2}>Documents</span>
      <span class="lblacts">
        {(awayCount || emptyCount) > 0 && <button type="button" class="btn sm act" id="f-locate"
          aria-haspopup="dialog" onClick={() => openLocate(store)}>
          <Icon name="folder" size={14} /><span>Locate…</span>
        </button>}
        {!awayCount && <button type="button" class="btn sm act" id="f-folders" aria-haspopup="dialog"
          onClick={() => store.ui({ newDeal: { name: d.name, folders: [], error: '', busy: false, forDeal: d.id } })}>
          <Icon name="folder" size={14} /><span>Folders</span>
        </button>}
      </span>
    </div>
    <div class="dcrows" id="ov-docs">
      {display.map((row) => <FolderDocumentRow key={row.key} row={row} progress={progress} />)}
      <CoreDocumentRow core={core} />
      {alsoIn.map(({ deal: match, docs, of }) => {
        const twin = dealTwin(s, match);
        const who = twin || match.counterparty;
        const tip = `The same files, by content, are in ${match.name}’s data room. `
          + 'Files other deals also hold, such as precedents, are not counted';
        return <div class="dcrow also" key={match.id} data-also={match.id}>
          <a class="fn" href={`#${dealHash(s.prefs, match.id)}`} title={`${match.name}${who ? ` · ${who}` : ''}`}>
            <span class="an">Also in {match.name}</span>{twin && <span class="copies">{twin}</span>}
          </a>
          <span class="rd" title={tip}>{num(docs)} of {num(of)} files</span>
        </div>;
      })}
    </div>
  </>;
}
