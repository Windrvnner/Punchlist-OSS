/**
 * The reading-mode document list: the documents under review (see conversationDocs), each once, with its
 * cited pages. Up to three pages sit beside the name; more flow on a line beneath, so a document cited
 * at many pages never squeezes its own name. Headings appear only when there is more than one group:
 * a deal conversation is grouped by the question asked, and a document opened from a follow-up answer
 * sits in its own group under that question.
 */
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { DocRef } from '../app/conversations';
import { docKey } from '../domain/model';
import { DocName } from './docName';
import { CachedMark } from './cached';
import { ChoiceCheck } from './moreMenu';
import { useAppState, useStore } from './hooks';
import type { DocPlaceRef } from '../ports';

type Item = { x: DocRef; i: number };                        // i is the place in the list; -1 for a document opened on its own
type Group = { key: string; ref: DocRef; items: Item[] };
type Section = { key: string; title: string; groups: Group[] };
const pageNo = (loc: string) => { const m = /p\.\s*(\d+)/.exec(loc); return m ? +m[1] : Number.MAX_SAFE_INTEGER; };
/** What cited it, as a heading: the question that was asked, or the finding / draft / response. */
const heading = (x: DocRef) => x.ask ?? x.from.replace(/^From /, '').replace(/^./, (c) => c.toUpperCase());
function byDocument(items: Item[]): Group[] {
  const out: Group[] = [];
  for (const it of items) { let g = out.find((y) => y.key === docKey(it.x)); if (!g) { g = { key: docKey(it.x), ref: it.x, items: [] }; out.push(g); } g.items.push(it); }
  return out;
}
export function menuSections(docs: DocRef[], aside: DocRef | null): Section[] {
  const buckets: { key: string; title: string; items: Item[] }[] = [];
  docs.forEach((x, i) => { let b = buckets.find((y) => y.key === x.from); if (!b) { b = { key: x.from, title: heading(x), items: [] }; buckets.push(b); } b.items.push({ x, i }); });
  if (aside) buckets.push({ key: 'aside', title: heading(aside), items: [{ x: aside, i: -1 }] });
  return buckets.map((b) => ({ key: b.key, title: b.title, groups: byDocument(b.items) }));
}

/**
 * Where else the same file sits, from its other places: each named by its folder, or by its own name when it
 * is in the document's own folder. The full paths are the tooltip.
 */
export function alsoIn(all: DocPlaceRef[]): { text: string; title: string } | null {
  if (all.length < 2) return null;
  const [first, ...rest] = all; const names = [...new Set(rest.map((p) => (p.folder === first.folder ? p.name : p.folder.split('/').pop() || p.folder)))];
  return { text: names.length === 1 ? `Also in ${names[0]}` : `Also in ${names.length} more folders: ${names.join(', ')}`, title: rest.map((p) => [...p.folder.split('/').filter(Boolean), p.name].join(' › ')).join('\n') };
}

function DocRow({ g, current, pick, dealId }: { g: Group; current: number; pick: (i: number) => void; dealId: string }) {
  const store = useStore(); const s = useAppState(); const deal = g.ref.dealId ?? dealId;
  useEffect(() => { void store.loadPlaces(deal, g.ref.docId); }, [deal, g.ref.docId]);
  const also = alsoIn(s.places[`${deal}|${g.ref.docId}`] ?? []);
  const on = g.items.some((it) => it.i === current); const pages = [...g.items].sort((a, b) => pageNo(a.x.loc) - pageNo(b.x.loc)); const many = pages.length > 3;
  const buttons = pages.map((it) => <button type="button" role="menuitem" key={it.x.loc} class={`dm-p ${it.i === current ? 'on' : ''}`} aria-current={it.i === current ? 'page' : undefined} aria-label={`${g.ref.doc}, ${it.x.loc}`} onClick={(e) => { e.stopPropagation(); pick(it.i); }}>{it.x.loc || '—'}</button>);
  return (
    <div class={`dm-r ${on ? 'on' : ''} ${many ? 'many' : ''} ${pages.length === 1 ? 'single' : ''} ${also ? 'also' : ''}`} onClick={() => pick(on ? current : pages[0].i)}>
      {also ? <span class="nmw"><span class="nm"><DocName name={g.ref.doc} /><CachedMark doc={g.ref} /></span><span class="alsoat" title={also.title}>{also.text}</span></span>
        : <span class="nm"><DocName name={g.ref.doc} /><CachedMark doc={g.ref} /></span>}
      {!many && <span class="pgs">{buttons}</span>}
      <span class="dtk"><ChoiceCheck on={on} /></span>
      {many && <span class="flow">{buttons}</span>}
    </div>);
}

export function DocMenu({ docs, index, aside, headed, pick, dealId }: { docs: DocRef[]; index: number | null; aside: DocRef | null; headed: boolean; pick: (i: number) => void; dealId: string }) {
  const root = useRef<HTMLDivElement>(null);
  // open with the page being read in view, however long the list is
  useLayoutEffect(() => { root.current?.querySelector('.dm-r.on')?.scrollIntoView({ block: 'nearest' }); }, []);
  const secs = menuSections(docs, aside); const current = aside ? -1 : index ?? 0; const titled = headed || secs.length > 1;
  return (
    <div class="docmenu dm" role="menu" ref={root}>{secs.map((sec) => (
      <div class="dm-sec" key={sec.key} role="group" aria-label={sec.title}>
        {titled && <div class="dm-h">{sec.title}</div>}
        {sec.groups.map((g) => <DocRow key={g.key} g={g} current={current} pick={pick} dealId={dealId} />)}
      </div>))}</div>);
}
