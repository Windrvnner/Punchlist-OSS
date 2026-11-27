// Scans screens for the pane-of-glass matches; shared by the check and by the history check of main's screens.
import { basename } from 'node:path';
import { groupMatches } from './allowance.mjs';
import { matchesIn, splitLines } from './pane-of-glass-matches.mjs';

function uiSource(file) {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) && !basename(file).includes('.test.');
}

// Each match of each screen among `files`, with the text of its line, grouped by line text.
export function scanUi(files, readSource) {
  const found = [];
  for (const file of files.filter(uiSource)) {
    const source = readSource(file);
    const lines = splitLines(source);
    for (const [kind, numbers] of Object.entries(matchesIn(file, source))) {
      for (const number of numbers) found.push({ file, kind, line: lines[number - 1], number });
    }
  }
  return groupMatches(found);
}
