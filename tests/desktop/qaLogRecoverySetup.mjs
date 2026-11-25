import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

export const room = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-desktop-log-'));
export const logFolder = path.join(room, 'logs');
const home = path.join(room, 'home');
const isolatedConfig = path.join(room, 'config');
const heading = 'No.,Question,Response\r\n';
const stem = 'Due diligence questions';
export const csv = {
  file: `${stem}.csv`, sheet: 'Sheet1', question: 'What permits remain outstanding?', answer: 'None.',
};
export const book = {
  file: `${stem}.xlsx`, sheet: stem, question: 'When was the facility commissioned?', answer: 'In May.',
};
export const addedQuestion = 'Please provide the latest compliance certificate.';
export const addedAnswer = 'The signed version is available.';

export function prepareFiles() {
  const local = path.join(home, 'local');
  const shared = path.join(room, 'shared');
  const source = path.join(room, 'fixture');
  for (const dir of [local, shared, logFolder, source]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(local, 'settings.json'), JSON.stringify({ sharedFolder: shared }));
  fs.writeFileSync(path.join(logFolder, csv.file), `${heading}1,${csv.question},${csv.answer}\r\n`);
  const workbookInput = path.join(source, csv.file);
  fs.writeFileSync(workbookInput, `${heading}1,${book.question},${book.answer}\r\n`);
  const profile = pathToFileURL(path.join(room, 'fixture-profile')).href;
  execFileSync('soffice', [
    `-env:UserInstallation=${profile}`, '--headless', '--convert-to', 'xlsx', '--outdir', logFolder, workbookInput,
  ], { timeout: 120_000, env: { ...process.env, XDG_CONFIG_HOME: isolatedConfig } });
  return new Map([csv, book].map(({ file }) => [file, fs.readFileSync(path.join(logFolder, file))]));
}

export async function launch(endpoint) {
  const env = { ...process.env };
  for (const name of ['PUNCHLIST_LIVE', 'PUNCHLIST_AI_CHECK', 'PUNCHLIST_AI_KEY']) delete env[name];
  const app = await electron.launch({
    args: [...(process.getuid?.() === 0 || process.env.CI ? ['--no-sandbox'] : []), '.'],
    env: { ...env, PUNCHLIST_HOME: home, XDG_CONFIG_HOME: isolatedConfig, ANTHROPIC_BASE_URL: endpoint },
  });
  try {
    const page = await app.firstWindow();
    const signIn = await page.evaluate(async () => {
      const status = await window.punchlist.call('signin', 'status', []);
      if (status.ok && status.value.signedIn) return status;
      return await window.punchlist.call('signin', 'paste', ['test-key']);
    });
    assert(signIn.ok, JSON.stringify(signIn));
    await page.waitForFunction(() => window.store?.get().boot.stage === 'ready');
    return { app, page };
  } catch (error) {
    await app.close();
    throw error;
  }
}

export async function seedDeals(page) {
  return await page.evaluate(async ({ folder, entries, addedQuestion, addedAnswer }) => {
    const dispatch = async (command, input) => {
      const result = await store.dispatch(store.commandNamed(command), input, { quiet: true });
      if (!result.ok) throw new Error(result.error.message);
    };
    const deals = [];
    for (const [index, log] of entries.entries()) {
      await dispatch('CreateDeal', { name: `Q&A log fixture ${index + 1}`, folders: [] });
      const deal = Object.values(store.get().deals).find((item) => item.name.endsWith(`fixture ${index + 1}`));
      await store.loadDeal(deal.id);
      const rows = [[log.question, log.answer], [addedQuestion, addedAnswer]].map(([text, response], row) => ({
        n: row + 1, line: row + 2, text, response, askedBy: '', received: '', workstream: '', priority: '',
        respondedBy: '', responded: '', status: '',
      }));
      await dispatch('ImportQuestions', { dealId: deal.id, mode: 'append', rows });
      const { file, sheet } = log;
      await dispatch('KeepQaLog', {
        dealId: deal.id,
        log: { name: file, file, folder, sheet, headerRow: 1, mapping: { n: 0, text: 1, response: 2 } },
      });
      deals.push(deal.id);
    }
    return deals;
  }, { folder: logFolder, entries: [csv, book], addedQuestion, addedAnswer });
}

// A stand-in accepts only the sign-in probe. A real model is never contacted.
export const server = createServer((request, response) => {
  if (request.method !== 'GET' || !request.url.startsWith('/v1/models?')) {
    response.writeHead(503).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }));
});
