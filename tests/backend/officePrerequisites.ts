import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

// check:all checks this converter first (scripts/office-check.mjs) and requires it: the LibreOffice tests then run
// and fail without it, rather than being skipped (#85). A plain test run skips them when /usr/bin/soffice is missing.
export const soffice = '/usr/bin/soffice';
export const hasOffice = process.env.PUNCHLIST_OFFICE === 'required' || existsSync(soffice);

export function hasImpress(): boolean {
  if (!existsSync(soffice)) return false;
  const program = dirname(realpathSync.native(soffice));
  return ['simpress', 'libsdlo.so'].some((file) => existsSync(join(program, file)));
}

export function hasMetricFont(font: 'Calibri'): boolean {
  try {
    const families = execFileSync('fc-match', ['-f', '%{family}', font], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return families.split(',').some((family) => family === font || family === 'Carlito');
  } catch {
    return false;
  }
}
