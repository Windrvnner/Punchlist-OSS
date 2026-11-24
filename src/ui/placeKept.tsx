import { useEffect, useState } from 'preact/hooks';
import { useStore } from './hooks';
import { Modal } from './dialogs';
import { Icon } from './icons';
import type { Store } from '../app/store';
import { keptRowTaken, LEAVE_KEPT_OUT, NEW_KEPT_ROW, type PlaceKept } from '../app/qaLog';
import type { KeptAsk } from '../domain/keptMerge';

/**
 * "Where does this edit go?": an edit kept aside beside the Q&A log changed a row the app can't
 * place for sure (a question asked twice, by nobody named; one the log took out or reworded). The update asks the person
 * which row it goes in, whether it is a row of its own, or to leave it out, before it saves; closing the dialog leaves the
 * update for later. One ask waits per deal; the update that opened it waits for the answer.
 */
const waiting = new Map<string, { ask: KeptAsk[]; done: (chose: number[] | null) => void }>();

/** the update's way to ask, for a deal: the dialog opens, and its answer (null when closed) comes back */
export const placeKept = (store: Store, dealId: string): PlaceKept => (ask) => new Promise((done) => {
  waiting.get(dealId)?.done(null);                                                   // an older ask of the same deal is closed
  waiting.set(dealId, { ask, done }); store.ui({ dialog: { kind: 'placeKept', dealId } });
});

const shown = (v: string) => v.trim() || '—';

export function PlaceKeptDialog({ dealId }: { dealId: string }) {
  const store = useStore(); const [w] = useState(() => waiting.get(dealId));
  const [chose, setChose] = useState<(number | undefined)[]>(() => (w ? w.ask.map(() => undefined) : []));
  const pick = (edit: number, target: number) => setChose((current) =>
    current.map((choice, index) => index === edit ? target : choice));
  const answer = (r: number[] | null) => { if (waiting.get(dealId) === w) waiting.delete(dealId); w?.done(r); store.ui({ dialog: null }); };
  // closed some other way (the deal deleted, another dialog over it): the update is left for later, never held
  useEffect(() => () => { if (w && waiting.get(dealId) === w) { waiting.delete(dealId); w.done(null); } }, []);
  if (!w) return null;
  const many = w.ask.length > 1; const title = many ? 'Where do these edits go?' : 'Where does this edit go?';
  const left = chose.filter((c) => c === undefined).length;
  return (
    <Modal onClose={() => answer(null)} label={title} blur className="sdlg pkdlg">
      <div class="shead"><h2 title="Saved while the Q&A log was being updated. The rows read alike and nothing tells which one was edited">{title}</h2><button type="button" class="x" id="pk-x" aria-label="Close" title="Close (Esc)" onClick={() => answer(null)}><Icon name="close" size={15} /></button></div>
      <div class="pkbody">
        {w.ask.map((a, i) => {
          const edit = a.cells.filter((c) => c.changed).map((c) => `${c.heading}: ${shown(c.theirs)}`).join(' · ');
          const name = `pk-${i}`;
          return (
            <div class="pkask" key={i} id={name}>
              <div class="srow"><div class="k">Question</div><div class="pkv" title={a.question}>{a.question}</div></div>
              <div class="srow"><div class="k">Their Edit</div><div class="pkv" title={edit}>{edit}</div></div>
              <div class="srow top"><div class="k">Goes In</div>
                <div class="xlist pklist" role="radiogroup" aria-label="Goes in">
                  {a.rows.map((r, k) => {
                    const cells = a.cells.map((c) => `${c.heading}: ${shown(c.rows[k])}`).join(' · ');
                    return <label key={r.row} title={`Row ${r.line} · ${cells}`}>
                      <input type="radio" name={name} checked={chose[i] === k}
                        disabled={keptRowTaken(w.ask, chose, i, k)} onChange={() => pick(i, k)} />
                      <span class="pkrow">Row {r.line.toLocaleString('en-US')}</span>
                      <span class="pkcells">{cells}</span>
                    </label>;
                  })}
                  <label><input type="radio" name={name} checked={chose[i] === NEW_KEPT_ROW}
                    onChange={() => pick(i, NEW_KEPT_ROW)} />
                    <span class="pkrow">New row</span></label>
                  <label title="Kept in the archive copy only">
                    <input type="radio" name={name} checked={chose[i] === LEAVE_KEPT_OUT}
                      onChange={() => pick(i, LEAVE_KEPT_OUT)} />
                    <span class="pkrow">Leave out</span></label>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div class="xfoot"><span
        id="pk-count">{many ? (left ? `${left} of ${w.ask.length} to place` : `${w.ask.length} placed`)
        : ''}</span><span class="grow" /><button class="btn sm pri" type="button" id="pk-go" disabled={left > 0}
        onClick={() => answer(chose as number[])}>Update Log</button></div>
    </Modal>
  );
}
