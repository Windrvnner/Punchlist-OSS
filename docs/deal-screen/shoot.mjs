// Renders each screen of the deal screen mock-up (mock.html) to a JPEG, as kept in shots/.
// Run `npm run build` first: the mock-up uses the app's built stylesheet, which this script serves as app.css.
// Usage: node docs/deal-screen/shoot.mjs [width]x[height] [light|dark] (light is the default)
// With no arguments it writes the light 1280x736 shots to shots/ beside this file, as kept in the repo. Any other size
// or the dark theme goes to out/deal-screen/ instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome } from '../../tests/browser/chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const unknown = args.filter((arg) => !/^\d+x\d+$/.test(arg) && arg !== 'dark' && arg !== 'light');
if (unknown.length > 0) {
  throw new Error(`Unknown arguments: ${unknown.join(' ')}. Use [width]x[height] and light or dark.`);
}
const sizeArg = args.find((arg) => /^\d+x\d+$/.test(arg)) || '1280x736';
const [width, height] = sizeArg.split('x').map(Number);
const theme = args.includes('dark') ? 'dark' : 'light';
const keptInRepo = width === 1280 && height === 736 && theme === 'light';
const outDir = keptInRepo ? path.join(here, 'shots') : path.join(here, '..', '..', 'out', 'deal-screen');

// Each screen's file name and the mock-up's hash parameters that set it up.
const SCREENS = [
  ['01-empty-deal', 'empty'],
  ['02-deal-menu-archive', 'empty&menu=1'],
  ['03-archive-confirm', 'empty&confirm=1'],
  ['04-archived-shown', 'empty&arch=1&toast=1'],
  ['05-unarchive-menu', 'empty&arch=1&umenu=1'],
  ['06-conversation', 'active'],
  ['07-answer-action-tooltip', 'active&tip=1'],
  ['08-past-conversations', 'active&past=1'],
  ['09-diligence-running', 'running'],
  ['10-other-conversation-tasks-kept', 'switch'],
  ['11-diligence-report', 'report'],
  ['12-finding', 'issue'],
  ['13-source-document', 'doc'],
  ['14-source-document-sidebar-shown', 'doc&side=1'],
  ['15-qa-widened', 'qa'],
  ['16-report-rechecking', 'busy'],
  ['17-finding-updating', 'issuebusy'],
  ['18-qa-item-draft', 'qaitem'],
  ['19-qa-item-answered', 'qaans'],
  ['20-task-running', 'taskrun'],
  ['21-task-done', 'taskdone'],
  ['22-sidebar-shown-qa', 'qa&side=1'],
  ['23-sidebar-shown-finding', 'issue&side=1'],
  ['24-qa-roomy', 'qafocus'],
  ['25-qa-roomy-item', 'qafocusitem'],
  ['26-qa-roomy-answered', 'qafocusitem&ans=1'],
  ['27-deal-header', 'dealheader'],
  ['28-deal-info', 'details'],
  ['29-folders', 'folders'],
  ['30-diligence', 'diligence'],
  ['32-tasks-needs-input', 'needsinput'],
  ['33-home-past-conversations', 'homepast'],
  ['34-archived-at-scale', 'archscale'],
];

/** The app's built stylesheet from dist/assets, which the mock-up loads as app.css. */
function builtStylesheet() {
  const assets = path.join(here, '..', '..', 'dist', 'assets');
  const css = fs.existsSync(assets) ? fs.readdirSync(assets).filter((name) => name.endsWith('.css')) : [];
  if (css.length === 0) throw new Error('No built stylesheet in dist/assets. Run npm run build first.');
  return css.map((name) => fs.readFileSync(path.join(assets, name), 'utf8')).join('\n');
}

const stylesheet = builtStylesheet();
fs.mkdirSync(outDir, { recursive: true });
const browser = await launchChrome();
const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1 });
await context.route('**/app.css', (route) => route.fulfill({ contentType: 'text/css', body: stylesheet }));
const page = await context.newPage();
const mockUrl = pathToFileURL(path.join(here, 'mock.html')).href;
for (const [name, setup] of SCREENS) {
  await page.goto(`${mockUrl}#s=${setup}&theme=${theme}`);
  // The mock-up reads its hash once, on load, so a reload applies the new screen.
  await page.reload();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, `${name}-${theme}-${width}x${height}.jpg`), quality: 85 });
}
await browser.close();
