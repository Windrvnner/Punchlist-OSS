// Run after the desktop build, under a virtual display on Linux. LibreOffice writes and reads the workbook fixture.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  addedAnswer, addedQuestion, book, csv, launch, logFolder, prepareFiles, room, seedDeals, server,
} from './qaLogRecoverySetup.mjs';

async function update(page, dealId) {
  await page.evaluate((id) => { location.hash = `#qa-${id}`; }, dealId);
  await page.waitForFunction((id) => store.get().dealLoad[id] === 'loaded', dealId);
  await page.locator('#qa-cols').click();
  await page.getByRole('menuitem', { name: 'Update Q&A Log' }).click();
}

/**
 * Whether the process ended from the kill the test planted. Windows has no signals: a process killed that way
 * ends with exit code 1 and no signal (#1027).
 */
function killedDirectly(code, signal) {
  if (process.platform === 'win32') return code === 1 && signal === null;
  return signal === 'SIGKILL';
}

async function interrupt({ app, page }, dealId, file) {
  const original = path.join(logFolder, file);
  const before = new Set(fs.readdirSync(logFolder));
  await app.evaluate((_, original) => {
    const fs = process.getBuiltinModule('node:fs');
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      rename(source, target);
      if (source === original && target.endsWith('.old')) process.kill(process.pid, 'SIGKILL');
    };
  }, original);
  const exit = once(app.process(), 'exit', { signal: AbortSignal.timeout(40_000) });
  const click = update(page, dealId).catch((error) => {
    if (!/closed/i.test(error.message)) throw error;
  });
  const [[code, signal]] = await Promise.all([exit, click]).catch(async (error) => {
    const notices = await page.evaluate(() => store.get().ui.toasts.map((toast) => toast.text)).catch(() => []);
    throw new Error(`The ${path.extname(file)} update did not reach the move. ${notices.join(' ')}`, { cause: error });
  });
  const ended = `code ${code}, signal ${signal}`;
  assert(killedDirectly(code, signal), `the desktop process exits directly after moving the log (${ended})`);
  assert(!fs.existsSync(original));
  const aside = fs.readdirSync(logFolder).find((name) => name.endsWith('.old') && !before.has(name));
  assert(aside);
  return path.join(logFolder, aside);
}

async function ageAsides(app, files) {
  await app.evaluate((_, entries) => {
    const fs = process.getBuiltinModule('node:fs');
    const stat = fs.statSync;
    fs.statSync = (file, options) => {
      const result = stat(file, options);
      const index = entries.indexOf(file);
      if (index >= 0) result.ctimeMs -= index === 0 ? 180_000 : 120_000;
      return result;
    };
  }, files);
}

async function checkRecovery(page, dealId, log) {
  await update(page, dealId);
  const outcome = await page.waitForFunction((id) => {
    const state = store.get();
    const failure = state.ui.toasts.find(({ text }) => text.startsWith('Q&A log not updated'));
    return failure?.text ?? !!state.deals[id]?.qaLogs[0]?.last;
  }, dealId);
  const saved = await outcome.jsonValue();
  assert.equal(saved, true);
  const result = await page.evaluate(({ folder, file, sheet }) =>
    window.punchlist.call('qaLogs', 'read', [{ folder, file }, { sheet, headerRow: 1 }]),
  { folder: logFolder, ...log });
  assert(result.ok, JSON.stringify(result));
  assert.deepEqual(result.value.rows, [['1', log.question, log.answer], ['2', addedQuestion, addedAnswer]]);
}

let desktop;
try {
  const original = prepareFiles();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  desktop = await launch(endpoint);
  const [csvDeal, bookDeal] = await seedDeals(desktop.page);
  const first = await interrupt(desktop, csvDeal, csv.file);
  desktop = await launch(endpoint);
  const second = await interrupt(desktop, bookDeal, book.file);
  assert.deepEqual(fs.readFileSync(first), original.get(csv.file));
  assert.deepEqual(fs.readFileSync(second), original.get(book.file));
  assert(!fs.existsSync(path.join(logFolder, csv.file)) && !fs.existsSync(path.join(logFolder, book.file)));

  desktop = await launch(endpoint);
  await ageAsides(desktop.app, [first, second]);
  await checkRecovery(desktop.page, csvDeal, csv);
  await checkRecovery(desktop.page, bookDeal, book);
  console.log('PASS desktop-qalog-recovery');
} finally {
  await desktop?.app.close().catch(() => undefined);
  server.close();
  fs.rmSync(room, { recursive: true, force: true });
}
