// Proves LibreOffice can do the spreadsheet work the tests need, before check:all runs them (#85).
//   node scripts/office-check.mjs        prints the converter's path and version, or why it cannot be used
// The converter is /usr/bin/soffice, the same one the tests use. It turns a two-sheet
// workbook into XLSX and back into one CSV per sheet, each on a fresh profile, as the app does. A missing converter,
// one that hangs, or one that writes the wrong result exits 1; `--version` alone would pass a build that hangs in Calc.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STEP_MS = 90_000;
const SHEETS = [['Questions', 'Question,Response', 'What is the cap?,1.25x'], ['Notes', 'Note', 'Second sheet']];

/** The converter the tests use (officePrerequisites.ts). */
export const SOFFICE = '/usr/bin/soffice';

/** A flat OpenDocument spreadsheet holding SHEETS, one cell per comma-separated value. */
function flatWorkbook() {
  const cell = (text) => `<table:table-cell office:value-type="string"><text:p>${text}</text:p></table:table-cell>`;
  const row = (line) => `<table:table-row>${line.split(',').map(cell).join('')}</table:table-row>`;
  const table = ([name, ...lines]) => `<table:table table:name="${name}">${lines.map(row).join('')}</table:table>`;
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"'
    + ' xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"'
    + ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"'
    + ' office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">'
    + `<office:body><office:spreadsheet>${SHEETS.map(table).join('')}</office:spreadsheet></office:body>`
    + '</office:document>';
}

/** Runs the converter on a fresh profile; throws with the reason when it fails or takes longer than STEP_MS. */
function run(soffice, dir, args) {
  const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
  const result = spawnSync(soffice, [`-env:UserInstallation=${pathToFileURL(profile).href}`, ...args], {
    encoding: 'utf8', timeout: STEP_MS,
  });
  if (result.error?.code === 'ETIMEDOUT') throw new Error(`no result within ${STEP_MS / 1000} s: ${args.join(' ')}`);
  if (result.error) throw new Error(`could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`exit ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

/** Converts the workbook to XLSX and back to one CSV per sheet, and checks every sheet's text came back. */
export function checkOffice(soffice) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-office-check-'));
  try {
    const version = run(soffice, dir, ['--version']);
    fs.writeFileSync(path.join(dir, 'in.fods'), flatWorkbook());
    const xlsx = 'xlsx:Calc MS Excel 2007 XML';
    run(soffice, dir, ['--headless', '--convert-to', xlsx, '--outdir', dir, path.join(dir, 'in.fods')]);
    const out = path.join(dir, 'out');
    const csv = 'csv:Text - txt - csv (StarCalc):44,34,76,1,,1033,true,true,false,false,false,-1';
    run(soffice, dir, ['--headless', '--convert-to', csv, '--outdir', out, path.join(dir, 'in.xlsx')]);
    for (const [name, ...lines] of SHEETS) {
      const file = path.join(out, `in-${name}.csv`);
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim() : '(no file)';
      const expected = lines.map((line) => line.split(',').map((value) => `"${value}"`).join(',')).join('\n');
      const same = text.replace(/\r\n/g, '\n') === expected;
      if (!same) throw new Error(`sheet ${name} came back as ${JSON.stringify(text)}`);
    }
    return version;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The converter and its version once it has converted the workbook; throws with the reason it cannot be used. */
export function usableOffice(soffice = SOFFICE) {
  if (!fs.existsSync(soffice)) throw new Error(`LibreOffice was not found: install it at ${soffice}`);
  try {
    return { soffice, version: checkOffice(soffice) };
  } catch (error) {
    throw new Error(`LibreOffice ${soffice} cannot convert spreadsheets: ${error.message}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { soffice, version } = usableOffice();
    console.log(`LibreOffice ${soffice}: ${version}; spreadsheets convert`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
