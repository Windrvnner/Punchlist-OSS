import { useAppState, useStore } from './hooks';
import { Modal } from './dialogs';
import { Icon } from './icons';
import { SetDealMember, isMine } from '../app/commands/members';
import { dealHash } from '../app/state';
import { matchingDealKinds, type TwinFound } from '../app/dupes';
import type { DealKinds } from '../app/state';

const day = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };

/**
 * "Is this Project X?": asked before a new deal is made, when it looks like one the team already has. It shows what
 * tells the two apart (the deal's counterparty and the day it was made), every other way the two are alike (the structure,
 * sector and technology picked on the form, where they are the deal's too) and how many files match, and only asks: Back returns to
 * the form as it was, Create Anyway makes the new deal, and the main action adds the deal that is there to the person's
 * deals, or opens it when it is already one of theirs. Escape and the × close it back to the form, so nothing typed is lost.
 */
const KIND_LABELS = { product: 'Structure', sector: 'Sector', technology: 'Technology' };

export function TwinConfirm({ found, kinds = {}, back, anyway }: { found: TwinFound; kinds?: DealKinds; back: () => void; anyway: () => void }) {
  const store = useStore(); const s = useAppState(); const d = s.deals[found.dealId];
  if (!d) return null;
  const mine = isMine(s, d.id);
  const go = async () => {
    if (!mine) { const r = await store.dispatch(SetDealMember, { dealId: d.id, on: true }, { idempotencyKey: `add-${d.id}` }); if (!r.ok) return; }
    store.ui({ newDeal: null }); location.hash = dealHash(store.get().prefs, d.id);
  };
  const goWords = mine ? `Open ${d.name}` : `Add ${d.name} to My Deals`;
  return (
    <Modal onClose={back} label={`Is this ${d.name}?`} blur className="sdlg twdlg">
      <div class="shead"><h2 id="tw-title"><span class="twn" title={d.name}>Is this {d.name}?</span></h2><button type="button" class="x" id="tw-x" aria-label="Close" title="Close (Esc)" onClick={back}><Icon name="close" size={15} /></button></div>
      <div class="twrows" id="tw-rows">
        {/* the data room that matches is why it asks, so it comes first */}
        {found.room && <RoomRow room={found.room} name={d.name} />}
        {d.counterparty && <div class="srow"><div class="k">Counterparty</div><div id="tw-cp">{d.counterparty}</div></div>}
        <div class="srow"><div class="k">Created</div><div id="tw-made">{day(d.createdAt)}</div></div>
        {matchingDealKinds(kinds, d).map((kind) => (
          <div class="srow" key={kind}>
            <div class="k">{KIND_LABELS[kind]}</div><div id={`tw-${kind}`}>{d[kind]}</div>
          </div>))}
      </div>
      {/* macOS order: the alternative alone at the left, Back and the main action at the right */}
      <div class="xfoot">
        <button type="button" class="btn sm" id="tw-anyway" onClick={anyway}>Create Anyway</button>
        <span class="grow" />
        <button type="button" class="btn sm" id="tw-back" onClick={back}>Back</button>
        <button type="button" class="btn sm pri twgo" id="tw-go" data-autofocus title={goWords}
          onClick={() => void go()}>
          <span class="twn">{goWords}</span>
        </button>
      </div>
    </Modal>
  );
}

/** The Data Room row: how many of the new folders' files match the deal's, with how they were compared on hover */
function RoomRow({ room, name }: { room: NonNullable<TwinFound['room']>; name: string }) {
  const matched = room.matched.toLocaleString('en-US');
  const files = room.files.toLocaleString('en-US');
  const how = `${matched} of the new folders’ ${files} files match ${name}’s documents by name and size, `
    + 'and the smallest match is identical by content. Files in a precedents folder are not counted';
  return (
    <div class="srow">
      <div class="k">Data Room</div>
      <div class="num" id="tw-room" title={how}>{matched} of {files} files match</div>
    </div>
  );
}
