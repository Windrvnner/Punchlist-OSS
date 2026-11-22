/**
 * The team's shared folder, in the desktop app (ports `SharedPlace`). `ConnectPage` is all the window shows until a folder
 * is connected on this PC, so nothing is saved before there is somewhere to share it; `SharedFolderRow` is its row in
 * Settings. Choosing a folder starts the app again on it. A folder outside OneDrive may be used, with a warning, since
 * something else may sync it.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SharedPlace } from '../ports';
import { Icon } from './icons';
import { control } from '../control';

type Picked = { path: string; inOneDrive: boolean };
/** the share link of the team's Punchlist folder, opened in the browser to add it to this PC's OneDrive (control file desktop.teamFolderLink) */
const TEAM_LINK = control.desktop.teamFolderLink;
const NOT_SYNCED = 'This folder is not in OneDrive.';
/** why that matters, in the tooltip of the button that uses it (no explanation on screen) */
const NOT_SYNCED_WHY = 'Other PCs will see these records only if something else syncs it.';

/** pick a folder, then use it: the steps both the page and the Settings row take */
function useChoice(place: SharedPlace) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const pick = async () => { setError(''); const r = await place.pick(); if (!r.ok) setError(r.error.message); else if (r.value) setPicked(r.value); };
  const use = async (path: string) => { setBusy(true); setError(''); const r = await place.use(path); if (!r.ok) { setError(r.error.message); setBusy(false); } };   // on success the window starts again
  return { picked, setPicked, busy, error, pick, use };
}

const PathBox = ({ path }: { path: string }) => <div class="cf-path" id="cf-path" title={path}><Icon name="folder" size={15} /><span>{path}</span></div>;

/** how often the connect page looks again, so a folder that has just synced to this PC is picked up without a click */
const LOOK_EVERY_MS = 5000;
const OPEN_TIP = 'Opens the team’s Punchlist folder in your browser. Choose Add shortcut to My files there; once OneDrive has synced it, the app connects on its own.';

export function ConnectPage({ place }: { place: SharedPlace }) {
  const [now, setNow] = useState<{ path: string | null; found: string[]; suggested: string | null; missing?: string } | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const c = useChoice(place);
  // one look at a time: a slow one (OneDrive or the registry taking its time) is not stacked on by the next
  const looking = useRef(false);
  const look = async () => { if (looking.current) return; looking.current = true; try { const r = await place.get(); if (r.ok) setNow(r.value); } finally { looking.current = false; } };
  useEffect(() => { void look(); const t = setInterval(() => void look(), LOOK_EVERY_MS); return () => clearInterval(t); }, []);
  // exactly one Punchlist folder on this PC holds the team's records and none is connected yet: that is the one, used
  // without asking
  const only = now && !now.path && now.found.length === 1 ? now.found[0] : null;
  useEffect(() => { if (only) void c.use(only); }, [only]);
  if (!now || (only && !c.error)) return null;
  const found = now.path ? [] : now.found;
  // what is on offer: the folder just picked, else one of those found, else (with no team folder link to open) the
  // OneDrive suggestion, not when the connected folder has gone missing: that one needs its own answer
  const offer: Picked | null = c.picked ?? (found.length ? { path: chosen && found.includes(chosen) ? chosen : found[0], inOneDrive: true }
    : now.suggested && !now.missing && !TEAM_LINK ? { path: now.suggested, inOneDrive: true } : null);
  // on screen only what is true now (a folder gone, OneDrive not found); why and how go in the main button's tooltip
  const line = now.missing ?? (offer || TEAM_LINK ? null : 'OneDrive was not found on this PC.');
  const gone = 'Records are saved only once the Punchlist folder can be reached.';
  const tip = offer && !offer.inOneDrive ? `${NOT_SYNCED_WHY} ${now.missing ? gone : 'Nothing is saved until a folder is connected.'}`
    : now.missing ? gone
    : `Deals, findings and Q&A are kept in a folder your OneDrive syncs, so every PC on the team sees the same records. ${offer ? 'Nothing is saved until one is connected.' : 'Sign in to OneDrive, then choose the team’s Punchlist folder.'}`;
  return (
    <div class="home firstrun" id="connect"><div class="center">
      <h1 class="ttl">Connect the Punchlist folder</h1>
      {line && <p class="fr-line">{line}</p>}
      {/* more than one Punchlist folder holds records: each is offered, the chosen one marked */}
      {!c.picked && found.length > 1
        ? <div class="cf-opts" role="group" aria-label="Punchlist folders on this PC">{found.map((f) => <button type="button" key={f} class="cf-path cf-opt" aria-pressed={f === offer?.path} title={f} onClick={() => setChosen(f)}><Icon name="folder" size={15} /><span>{f}</span></button>)}</div>
        : offer && <PathBox path={offer.path} />}
      {offer && !offer.inOneDrive && <p class="cf-warn" id="cf-warn">{NOT_SYNCED}</p>}
      {c.error && <p class="cf-warn" role="alert" id="cf-error">{c.error}</p>}
      <div class="cf-row">
        {offer
          ? <button type="button" class="btn pri fr-new" id="cf-use" data-autofocus title={tip} disabled={c.busy}
            onClick={() => void c.use(offer.path)}>{offer.inOneDrive ? 'Use This Folder' : 'Use It Anyway'}</button>
          : TEAM_LINK && !now.missing
            ? <button type="button" class="btn pri fr-new" id="cf-open" data-autofocus title={OPEN_TIP}
              onClick={() => window.open(TEAM_LINK, '_blank')}>Open the Team Folder</button>
            : <button type="button" class="btn pri fr-new" id="cf-choose" data-autofocus title={tip}
              onClick={() => void c.pick()}><Icon name="folder" size={15} /> Choose Folder…</button>}
        {(offer || (TEAM_LINK && !now.missing)) && <button type="button" class="btn fr-new" id="cf-other"
          disabled={c.busy} onClick={() => void c.pick()}>{offer ? 'Choose Another…' : 'Choose Folder…'}</button>}
      </div>
    </div></div>
  );
}

/** Settings: the shared folder in use, with Change. Nothing changes until the person confirms the folder they picked. */
export function SharedFolderRow({ place }: { place: SharedPlace }) {
  const [path, setPath] = useState<string | null>(null);
  const c = useChoice(place);
  useEffect(() => { void place.get().then((r) => { if (r.ok) setPath(r.value.path); }); }, []);
  return (
    <div class="srow top" id="s-shared"><div class="k">Punchlist Folder</div><div class="cf-set">
      <div class="cf-line"><span class="cf-now" title={(c.picked ?? { path })?.path ?? ''}>{c.picked?.path ?? path ?? ''}</span>
        {c.picked
          ? <><button type="button" class="btn sm pri" id="s-shared-use"
            title={c.picked.inOneDrive ? 'The app starts again on this folder.'
            : `${NOT_SYNCED_WHY} The app starts again on it.`} disabled={c.busy}
            onClick={() => void c.use(c.picked!.path)}>{c.picked.inOneDrive ? 'Use This Folder'
            : 'Use It Anyway'}</button><button type="button" class="btn sm" id="s-shared-cancel" disabled={c.busy}
            onClick={() => c.setPicked(null)}>Cancel</button></>
          : <button type="button" class="btn sm" id="s-shared-change" onClick={() => void c.pick()}>Change…</button>}
      </div>
      {c.picked && !c.picked.inOneDrive && <p class="cf-note">{NOT_SYNCED}</p>}
      {c.error && <p class="cf-note warn" role="alert">{c.error}</p>}
    </div></div>
  );
}
