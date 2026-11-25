/**
 * The team's shared folder in the desktop app. `ConnectPage` is all the window shows until a folder
 * is connected on this PC, so nothing is saved before there is somewhere to share it; `SharedFolderRow` is its row in
 * Settings. Choosing a folder starts the app again on it. A folder outside OneDrive may be used, with a warning, since
 * something else may sync it.
 */
import { sharedFolderOffer, type SharedFolderConnection } from '../app/connection';
import { useConnectionForm } from './hooks';
import { Icon } from './icons';

const NOT_SYNCED = 'This folder is not in OneDrive.';
/** why that matters, in the tooltip of the button that uses it (no explanation on screen) */
const NOT_SYNCED_WHY = 'Other PCs will see these records only if something else syncs it.';

const PathBox = ({ path }: { path: string }) => <div class="cf-path" id="cf-path" title={path}><Icon name="folder" size={15} /><span>{path}</span></div>;

const OPEN_TIP = 'Opens the team’s Punchlist folder in your browser. Choose Add shortcut to My files there; once OneDrive has synced it, the app connects on its own.';
const CONNECT_NOTE = 'Nothing is saved until a folder is connected.';
type FolderOffer = ReturnType<typeof sharedFolderOffer>['offer'];

function connectTip(offer: FolderOffer, missing?: string) {
  const gone = 'Records are saved only once the Punchlist folder can be reached.';
  if (offer && !offer.inOneDrive) return `${NOT_SYNCED_WHY} ${missing ? gone : CONNECT_NOTE}`;
  if (missing) return gone;
  const synced = 'Deals, findings and Q&A are kept in a folder your OneDrive syncs, '
    + 'so every PC on the team sees the same records. ';
  return synced + (offer ? 'Nothing is saved until one is connected.'
    : 'Sign in to OneDrive, then choose the team’s Punchlist folder.');
}

function ConnectActions({ form, offer, teamLink, tip, busy }: {
  form: SharedFolderConnection;
  offer: FolderOffer;
  teamLink: string;
  tip: string;
  busy: boolean;
}) {
  return (
    <div class="cf-row">
      {offer
        ? <button type="button" class="btn pri fr-new" id="cf-use" data-autofocus title={tip} disabled={busy}
          onClick={() => void form.useFolder(offer.path)}>{offer.inOneDrive ? 'Use This Folder' : 'Use It Anyway'}
        </button>
        : teamLink
          ? <button type="button" class="btn pri fr-new" id="cf-open" data-autofocus title={OPEN_TIP}
            onClick={() => window.open(teamLink, '_blank')}>Open the Team Folder</button>
          : <button type="button" class="btn pri fr-new" id="cf-choose" data-autofocus title={tip}
            onClick={() => void form.pick()}><Icon name="folder" size={15} /> Choose Folder…</button>}
      {(offer || teamLink) && <button type="button" class="btn fr-new" id="cf-other"
        disabled={busy} onClick={() => void form.pick()}>{offer ? 'Choose Another…' : 'Choose Folder…'}</button>}
    </div>
  );
}

export function ConnectPage({ form }: { form: SharedFolderConnection }) {
  const state = useConnectionForm(form);
  const { status, busy, error } = state;
  const { choices, offer, teamLink, visible } = sharedFolderOffer(state);
  if (!status || !visible) return null;
  // on screen only what is true now (a folder gone, OneDrive not found); why and how go in the main button's tooltip
  const line = status.missing ?? (offer || teamLink ? null : 'OneDrive was not found on this PC.');
  return (
    <div class="home firstrun" id="connect"><div class="center">
      <h1 class="ttl">Connect the Punchlist folder</h1>
      {line && <p class="fr-line">{line}</p>}
      {/* more than one Punchlist folder holds records: each is offered, the chosen one marked */}
      {choices.length
        ? <div class="cf-opts" role="group" aria-label="Punchlist folders on this PC">
            {choices.map((path) => <button type="button" key={path} class="cf-path cf-opt"
              aria-pressed={path === offer?.path} title={path} onClick={() => form.choose(path)}>
              <Icon name="folder" size={15} /><span>{path}</span>
            </button>)}
          </div>
        : offer && <PathBox path={offer.path} />}
      {offer && !offer.inOneDrive && <p class="cf-warn" id="cf-warn">{NOT_SYNCED}</p>}
      {error && <p class="cf-warn" role="alert" id="cf-error">{error}</p>}
      <ConnectActions form={form} offer={offer} teamLink={teamLink}
        tip={connectTip(offer, status.missing)} busy={busy} />
    </div></div>
  );
}

/** Settings: the shared folder in use, with Change. Nothing changes until the person confirms the folder they picked. */
export function SharedFolderRow({ form }: { form: SharedFolderConnection }) {
  const { status, picked, busy, error } = useConnectionForm(form);
  const path = picked?.path ?? status?.path ?? '';
  return (
    <div class="srow top" id="s-shared"><div class="k">Punchlist Folder</div><div class="cf-set">
      <div class="cf-line"><span class="cf-now" title={path}>{path}</span>
        {picked
          ? <><button type="button" class="btn sm pri" id="s-shared-use"
            title={picked.inOneDrive ? 'The app starts again on this folder.'
            : `${NOT_SYNCED_WHY} The app starts again on it.`} disabled={busy}
            onClick={() => void form.useFolder(picked.path)}>{picked.inOneDrive ? 'Use This Folder'
            : 'Use It Anyway'}</button><button type="button" class="btn sm" id="s-shared-cancel" disabled={busy}
            onClick={form.cancel}>Cancel</button></>
          : <button type="button" class="btn sm" id="s-shared-change" onClick={() => void form.pick()}>Change…</button>}
      </div>
      {picked && !picked.inOneDrive && <p class="cf-note">{NOT_SYNCED}</p>}
      {error && <p class="cf-note warn" role="alert">{error}</p>}
    </div></div>
  );
}
