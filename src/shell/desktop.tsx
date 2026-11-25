/**
 * The desktop app's window: the Store on the real backend, reached across the bridge (bridge.ts) that the preload puts
 * on `window.punchlist`. Preferences, unsaved typing and the clock and ids stay in the window, as in the browser demo.
 */
import { Store } from '../app/store';
import { startupConnection } from '../app/connection';
import { systemClock, ulidIds } from '../adapters/mocks';
import { BrowserLocal } from '../adapters/local';
import { csvCodec } from '../adapters/spreadsheet';
import { bridged, type BridgeApi, type Available } from './bridge';
import { render } from 'preact';
import { COMMANDS, run } from './common';
import { ConnectPage } from '../ui/connect';
import { SignInPage } from '../ui/signin';

const api = (window as unknown as { punchlist: BridgeApi }).punchlist;
// Which methods the backend has decides which features show. If the main process does not answer, every call says
// "unreachable" and the Store keeps retrying, as it does when the backend cannot be reached.
let available: Available;
try { available = await api.describe(); } catch { available = { repo: [], ai: [], docs: [], session: ['load'] }; }
const services = bridged(api, available);
const page = (el: preact.JSX.Element) => {
  document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  render(<div id="app" class="connect"><section class="stage"><main class="view homeview" id="view" tabIndex={-1}>{el}</main></section></div>, document.getElementById('root')!);
};
const startup = await startupConnection(services, !!available.repo, () => location.reload());
if (startup.stage === 'signin') {
  page(<SignInPage form={startup.form} />);
} else if (startup.stage === 'connect') {
  page(<ConnectPage form={startup.form} />);
} else {
  const store: Store = new Store({
    ...services, sheets: services.sheets ?? csvCodec, local: new BrowserLocal(), clock: systemClock, ids: ulidIds,
  }, COMMANDS);
  (window as unknown as { store: Store }).store = store; // for the desktop tests and the console
  await run(store);
}
